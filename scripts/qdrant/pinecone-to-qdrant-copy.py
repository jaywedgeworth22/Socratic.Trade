#!/usr/bin/env python3
"""Copy Socratic.Trade vectors from Pinecone to Qdrant.

Owner rule (2026-08-28): copy ALL non-Voyage embeds.  ST's vector-db.ts tags
records with an `embed_model` metadata field; voyage-era records are exactly
the ones WITHOUT it (the voyage query path uses an empty filter), so the copy
keeps records where embed_model exists and is not voyage-*.

Env: PINECONE_API_KEY, QDRANT_URL, QDRANT_API_KEY
Optional: COPY_STATE (state file), COPY_LOG (log file), INDEX_NAME, COLLECTION
Read-only against Pinecone; writes only to the Qdrant collection.
Resumable: per-namespace pagination token persisted after every page.
"""
import json, os, sys, time, uuid, threading, queue
import urllib.request, urllib.error, urllib.parse

PC_KEY = os.environ["PINECONE_API_KEY"]
Q_URL = os.environ["QDRANT_URL"].rstrip("/")
Q_KEY = os.environ["QDRANT_API_KEY"]
INDEX = os.environ.get("INDEX_NAME", "socratic-trade")
COLL = os.environ.get("COLLECTION", "socratic-trade")
STATE_PATH = os.environ.get("COPY_STATE", "qdrant-copy-state.json")
LOG_PATH = os.environ.get("COPY_LOG", "qdrant-copy.log")
FETCH_BATCH = 35  # corpus ids are ~155 chars; 99 ids -> 17KB URL -> HTTP 414
WORKERS = 6

log_lock = threading.Lock()
def log(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    with log_lock:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")

def http(method, url, headers, body=None, tries=5):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
            code = getattr(e, "code", None)
            if code is not None and 400 <= code < 500 and code != 429:
                raise
            time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f"retries exhausted: {method} {url.split('?')[0]}")

def pc(method, path, body=None, host=None):
    base = host or "https://api.pinecone.io"
    return http(method, base + path,
                {"Api-Key": PC_KEY, "Content-Type": "application/json",
                 "X-Pinecone-API-Version": "2025-01"}, body)

def qd(method, path, body=None):
    return http(method, Q_URL + path,
                {"api-key": Q_KEY, "Content-Type": "application/json"}, body)

def load_state():
    if os.path.exists(STATE_PATH):
        return json.load(open(STATE_PATH))
    return {"done_ns": [], "current_ns": None, "token": None,
            "scanned": 0, "copied": 0, "skipped_no_model": 0, "skipped_voyage": 0}

def save_state(st):
    tmp = STATE_PATH + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, STATE_PATH)

def to_point(pc_id, values, metadata, ns):
    payload = dict(metadata or {})
    payload["ns"] = ns
    payload["pc_id"] = pc_id
    return {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "st:" + ns + ":" + pc_id)),
            "vector": values, "payload": payload}

def keep(md):
    m = (md or {}).get("embed_model")
    if not m:
        return "no_model"
    if str(m).lower().startswith("voyage"):
        return "voyage"
    return "keep"

def main():
    host = "https://" + pc("GET", f"/indexes/{INDEX}")["host"]
    stats = http("POST", host + "/describe_index_stats",
                 {"Api-Key": PC_KEY, "Content-Type": "application/json",
                  "X-Pinecone-API-Version": "2025-01"}, {})
    namespaces = sorted(stats.get("namespaces", {}).items(),
                        key=lambda kv: kv[1].get("vectorCount", 0))
    st = load_state()
    log(f"start: {len(namespaces)} namespaces, resume state scanned={st['scanned']}")

    work_q, err = queue.Queue(maxsize=WORKERS * 2), []
    counts_lock = threading.Lock()

    def worker():
        while True:
            item = work_q.get()
            if item is None:
                return
            ns, ids = item
            try:
                qs = "&".join(["ids=" + urllib.parse.quote(i) for i in ids])
                nsq = "&namespace=" + urllib.parse.quote(ns) if ns != "__default__" else ""
                res = http("GET", f"{host}/vectors/fetch?{qs}{nsq}",
                           {"Api-Key": PC_KEY, "X-Pinecone-API-Version": "2025-01"})
                points, n_nm, n_v = [], 0, 0
                for pc_id, rec in (res.get("vectors") or {}).items():
                    k = keep(rec.get("metadata"))
                    if k == "keep":
                        points.append(to_point(pc_id, rec["values"], rec.get("metadata"), ns))
                    elif k == "no_model":
                        n_nm += 1
                    else:
                        n_v += 1
                if points:
                    qd("PUT", f"/collections/{COLL}/points?wait=false", {"points": points})
                with counts_lock:
                    st["scanned"] += len(ids)
                    st["copied"] += len(points)
                    st["skipped_no_model"] += n_nm
                    st["skipped_voyage"] += n_v
            except Exception as e:
                code = getattr(e, "code", "")
                err.append((ns, ids))
                log(f"WORKER-ERROR ns={ns} {type(e).__name__} {code} batch={len(ids)}")
            finally:
                work_q.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
    for t in threads:
        t.start()

    last_log = 0
    for ns, meta in namespaces:
        if ns in st["done_ns"]:
            continue
        token = st["token"] if st["current_ns"] == ns else None
        st["current_ns"] = ns
        while True:
            nsq = "?limit=99" + ("&namespace=" + urllib.parse.quote(ns) if ns != "__default__" else "")
            if token:
                nsq += "&paginationToken=" + urllib.parse.quote(token)
            page = http("GET", f"{host}/vectors/list{nsq}",
                        {"Api-Key": PC_KEY, "X-Pinecone-API-Version": "2025-01"})
            ids = [v["id"] for v in page.get("vectors", [])]
            for i in range(0, len(ids), FETCH_BATCH):
                work_q.put((ns, ids[i:i + FETCH_BATCH]))
            token = (page.get("pagination") or {}).get("next")
            st["token"] = token
            if st["scanned"] - last_log >= 20000:
                last_log = st["scanned"]
                log(f"progress scanned={st['scanned']} copied={st['copied']} "
                    f"no_model={st['skipped_no_model']} voyage={st['skipped_voyage']} ns={ns}")
                save_state(st)
            if not token:
                break
        work_q.join()
        retries = [b for b in err if b[0] == ns]
        if retries:
            log(f"retrying {len(retries)} failed batches for {ns} in halves")
            err[:] = [b for b in err if b[0] != ns]
            for _, bad in retries:
                half = max(1, len(bad) // 2)
                for j in range(0, len(bad), half):
                    work_q.put((ns, bad[j:j + half]))
            work_q.join()
        if any(b[0] == ns for b in err):
            log(f"NAMESPACE-INCOMPLETE {ns}: {sum(1 for b in err if b[0] == ns)} batches still failing — NOT marking done")
            st["current_ns"], st["token"] = None, None
            save_state(st)
            continue
        st["done_ns"].append(ns)
        st["current_ns"], st["token"] = None, None
        save_state(st)
        if meta.get("vectorCount", 0) > 1000:
            log(f"namespace done: {ns} ({meta.get('vectorCount')} src vectors)")
    work_q.join()
    for _ in threads:
        work_q.put(None)
    qd("POST", f"/collections/{COLL}/points/count", {"exact": True})
    final = qd("POST", f"/collections/{COLL}/points/count", {"exact": True})
    log(f"DONE scanned={st['scanned']} copied={st['copied']} no_model={st['skipped_no_model']} "
        f"voyage={st['skipped_voyage']} errors={len(err)} qdrant_count={final.get('result', {}).get('count')}")
    save_state(st)
    print(json.dumps({"scanned": st["scanned"], "copied": st["copied"],
                      "skipped_no_model": st["skipped_no_model"],
                      "skipped_voyage": st["skipped_voyage"], "errors": len(err),
                      "qdrant_count": final.get("result", {}).get("count")}))

if __name__ == "__main__":
    main()
