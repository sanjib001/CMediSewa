import { cn } from "@/lib/cn";

/**
 * The OPD ticket: CMediSewa's signature element (ui-ux.md §12).
 * The paper token slip a Nepali OPD hands over at registration: punched notches and a
 * perforation above the stub. Used on the registrar queue, the token print and the
 * patient's booking confirmation. Marigold appears only here and on token numbers.
 */
export function OpdTicket({
  token, doctor, room, time, size = "md", className,
}: {
  token: number | string;
  doctor: string;
  room?: string;
  time?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const num = size === "lg" ? "text-7xl" : size === "sm" ? "text-3xl" : "text-5xl";
  const pad = size === "sm" ? "px-4 pt-3 pb-2" : "px-6 pt-5 pb-3";
  return (
    <div className={cn("opd-ticket inline-flex min-w-40 flex-col", className)} style={{ ["--ticket-cut" as string]: "64%" }}>
      <div className={cn("flex items-end justify-between gap-4", pad)}>
        <div>
          <div className="text-sm font-medium opacity-80">Token</div>
          <div className={cn(num, "font-bold leading-none tracking-tight")}>{token}</div>
        </div>
        {time ? <div className="pb-1 text-sm font-medium">{time}</div> : null}
      </div>
      <span className="opd-ticket__perforation" aria-hidden />
      <div className={cn("mt-auto text-sm", size === "sm" ? "px-4 pt-3 pb-2.5" : "px-6 pt-4 pb-3")}>
        <div className="font-semibold">{doctor}</div>
        {room ? <div className="opacity-80">{room}</div> : null}
      </div>
    </div>
  );
}
