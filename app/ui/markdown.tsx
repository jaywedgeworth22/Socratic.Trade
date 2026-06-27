"use client";

// Render assistant chat text as full Markdown (CommonMark + GFM: bold/italic, lists, headings,
// links, code/code-blocks, tables, blockquotes). react-markdown does NOT render raw HTML (no
// rehype-raw), so embedded HTML/script in model output is escaped — safe to show untrusted text.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./cn";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (props) => <p className="my-2 whitespace-pre-wrap" {...props} />,
          a: ({ href, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-dotted" {...props} />
          ),
          ul: (props) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
          ol: (props) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => <strong className="font-semibold text-fg" {...props} />,
          em: (props) => <em className="italic" {...props} />,
          h1: (props) => <h1 className="mb-1 mt-3 text-base font-semibold text-fg" {...props} />,
          h2: (props) => <h2 className="mb-1 mt-3 text-sm font-semibold text-fg" {...props} />,
          h3: (props) => <h3 className="mb-1 mt-2 text-sm font-semibold text-fg" {...props} />,
          blockquote: (props) => <blockquote className="my-2 border-l-2 border-line pl-3 text-muted" {...props} />,
          hr: () => <hr className="my-3 border-line" />,
          code: ({ className: cls, children: kids, ...props }) => {
            const isBlock = typeof cls === "string" && cls.includes("language-");
            if (isBlock) {
              return (
                <code className={cn("block overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[0.8rem]", cls)} {...props}>
                  {kids}
                </code>
              );
            }
            return (
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                {kids}
              </code>
            );
          },
          pre: (props) => <pre className="my-2 overflow-x-auto" {...props} />,
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...props} />
            </div>
          ),
          th: (props) => <th className="border border-line px-2 py-1 text-left font-semibold" {...props} />,
          td: (props) => <td className="border border-line px-2 py-1" {...props} />
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
