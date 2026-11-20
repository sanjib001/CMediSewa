// DEMO DATA for the Phase 1 outline (U1) only. Every screen that uses it says so.
// Nothing here is real: names, registration numbers, prices and stock are invented.
// It is replaced screen by screen by real Server Actions as the B-milestones land.

export const DEMO_CLINIC = {
  slug: "arogya-demo",
  name: "Arogya Clinic & Pharmacy",
  nameNe: "आरोग्य क्लिनिक तथा फार्मेसी",
  address: "Pulchowk, Lalitpur",
  phone: "01-5550123",
  hours: "Sun–Fri 7:00–19:00 · Sat 9:00–13:00",
  todayAd: "2026-11-20",
  todayBs: "2083 Mangsir 4",
};

export type DemoDoctor = {
  id: string;
  name: string;
  specialty: string;
  department: string;
  qualification: string;
  nmc: string;
  room: string;
  opd: string;
  fee: number;
};

export const DEMO_DOCTORS: DemoDoctor[] = [
  { id: "d1", name: "Dr. Anjali Shrestha", specialty: "General medicine", department: "General OPD", qualification: "MBBS, MD", nmc: "NMC 00000 (demo)", room: "Room 2", opd: "Sun–Fri · 8:00–13:00", fee: 500 },
  { id: "d2", name: "Dr. Bikash Karki", specialty: "Paediatrics", department: "Children", qualification: "MBBS, MD (Paed)", nmc: "NMC 00001 (demo)", room: "Room 3", opd: "Sun, Tue, Thu · 15:00–18:00", fee: 700 },
  { id: "d3", name: "Dr. Sunita Maharjan", specialty: "Gynaecology", department: "Women's health", qualification: "MBBS, MS (ObGyn)", nmc: "NMC 00002 (demo)", room: "Room 4", opd: "Mon, Wed, Fri · 10:00–14:00", fee: 800 },
];

export type QueueStatus = "waiting" | "with_doctor" | "done" | "booked" | "no_show";

export type DemoVisit = {
  token: number;
  patient: string;
  age: string;
  doctorId: string;
  status: QueueStatus;
  time: string;
  waitMin?: number;
  paid: boolean;
};

export const DEMO_QUEUE: DemoVisit[] = [
  { token: 12, patient: "Sita Tamang", age: "34 F", doctorId: "d1", status: "done", time: "08:20", paid: true },
  { token: 13, patient: "Ram Bahadur Thapa", age: "61 M", doctorId: "d1", status: "with_doctor", time: "08:45", paid: true },
  { token: 14, patient: "Gita Rai", age: "27 F", doctorId: "d1", status: "waiting", time: "09:05", waitMin: 18, paid: true },
  { token: 15, patient: "Hari Prasad Adhikari", age: "45 M", doctorId: "d1", status: "waiting", time: "09:20", waitMin: 6, paid: true },
  { token: 4, patient: "Aarav Gurung", age: "6 M", doctorId: "d2", status: "booked", time: "15:00", paid: false },
  { token: 5, patient: "Prisha Lama", age: "3 F", doctorId: "d2", status: "booked", time: "15:15", paid: false },
  { token: 7, patient: "Manisha KC", age: "29 F", doctorId: "d3", status: "with_doctor", time: "10:30", paid: true },
];

export type DemoRxLine = { medicine: string; dose: string; qty: string; batch: string; expiry: string; stock: "ok" | "low" | "near_expiry" };

export const DEMO_DISPENSING = [
  {
    rx: "RX-2082/83-0418", patient: "Sita Tamang", doctor: "Dr. Anjali Shrestha", issued: "08:31",
    allergy: "Penicillin",
    lines: [
      { medicine: "Paracetamol 500 mg tab", dose: "1 tab three times a day × 5 days", qty: "15 tab", batch: "PC2408A", expiry: "2027-03", stock: "ok" },
      { medicine: "Cetirizine 10 mg tab", dose: "1 tab at night × 5 days", qty: "5 tab", batch: "CT1123", expiry: "2026-12", stock: "near_expiry" },
    ] satisfies DemoRxLine[],
  },
  {
    rx: "RX-2082/83-0419", patient: "Manisha KC", doctor: "Dr. Sunita Maharjan", issued: "10:52",
    allergy: null,
    lines: [
      { medicine: "Ferrous sulphate + folic acid cap", dose: "1 cap daily × 30 days", qty: "30 cap", batch: "FF0907", expiry: "2027-09", stock: "low" },
    ] satisfies DemoRxLine[],
  },
];

export const DEMO_STOCK_ALERTS = [
  { item: "Cetirizine 10 mg tab", detail: "Batch CT1123 expires 2026-12 · 140 tab", kind: "near_expiry" as const },
  { item: "Amoxicillin 500 mg cap", detail: "Batch AX0611 expired 2026-11-15 · 40 cap · move to quarantine", kind: "expired" as const },
  { item: "Ferrous sulphate + folic acid cap", detail: "60 cap left · reorder level 200", kind: "low" as const },
  { item: "ORS sachet", detail: "18 left · reorder level 50", kind: "low" as const },
];

export const DEMO_TODAY = {
  booked: 32, arrived: 20, waiting: 6, done: 12,
  opdRevenue: 10_400, pharmacyRevenue: 18_750, cash: 17_200, online: 11_950, dues: 2_300, payables: 46_800,
};

export const DEMO_TENANTS = [
  { name: "Arogya Clinic & Pharmacy", slug: "arogya-demo", status: "active", plan: "Clinic + Pharmacy", expires: "2083 Kartik 30", staff: 9, lastActive: "2 min ago" },
  { name: "Sagarmatha Health Care", slug: "sagarmatha-demo", status: "pending", plan: "Clinic + Pharmacy", expires: "—", staff: 1, lastActive: "setting up" },
  { name: "Bagmati Family Clinic", slug: "bagmati-demo", status: "suspended", plan: "Clinic + Pharmacy", expires: "2083 Kartik 2", staff: 5, lastActive: "18 days ago" },
];

export const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN")}`;
