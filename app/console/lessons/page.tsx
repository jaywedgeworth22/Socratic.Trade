import { LearnedContextInbox, LearnedFactsArchive } from "./learned-context";

export default function LessonsPage() {
  return (
    <div className="mx-auto w-full max-w-[var(--con-page-w)] space-y-8 px-4 pb-12 pt-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Lessons</h1>
      </div>

      <div className="flex flex-col gap-8">
        <LearnedContextInbox />
        <LearnedFactsArchive />
      </div>
    </div>
  );
}
