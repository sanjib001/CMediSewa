import {
  Activity, AlertTriangle, ArrowLeftRight, BarChart3, Boxes, Building2, CalendarDays, CheckCircle2,
  ChevronRight, ClipboardList, Clock, CreditCard, Delete, FileText, FlaskConical, Globe, KeyRound,
  LayoutDashboard, Lock, LogOut, MapPin, Menu, Package, Phone, Pill, Receipt, Search, Settings,
  ShieldCheck, Stethoscope, Ticket, Truck, UserPlus, Users, Wallet, Bell, type LucideIcon,
} from "lucide-react";

// Explicit registry (not `import *`) so only these icons ship, and nav config can name
// icons as strings without importing React components into plain modules.
const ICONS: Record<string, LucideIcon> = {
  Activity, AlertTriangle, ArrowLeftRight, BarChart3, Bell, Boxes, Building2, CalendarDays, CheckCircle2,
  ChevronRight, ClipboardList, Clock, CreditCard, Delete, FileText, FlaskConical, Globe, KeyRound,
  LayoutDashboard, Lock, LogOut, MapPin, Menu, Package, Phone, Pill, Receipt, Search, Settings,
  ShieldCheck, Stethoscope, Ticket, Truck, UserPlus, Users, Wallet,
};

export function Icon({ name, className, label }: { name: string; className?: string; label?: string }) {
  const Cmp = ICONS[name] ?? FileText;
  return <Cmp className={className ?? "size-4"} aria-hidden={label ? undefined : true} aria-label={label} strokeWidth={1.75} />;
}
