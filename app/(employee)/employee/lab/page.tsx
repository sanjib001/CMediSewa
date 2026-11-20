import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Lab" };

export default function LabDesk() {
  return (
    <>
      <PageHeader title="Lab" />
      <Panel>
        <p className="text-ink-soft">The laboratory dashboard (worklist, samples, results) is planned for Phase 3.</p>
      </Panel>
    </>
  );
}
