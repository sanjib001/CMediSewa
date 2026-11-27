import { PageSkeleton } from "@/components/ui/skeleton";

// Shown inside the admin shell (top bar and menu stay) while any admin screen loads.
export default function Loading() {
  return <PageSkeleton />;
}
