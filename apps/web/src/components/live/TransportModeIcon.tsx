"use client";

export function TransportModeIcon({
  mode,
  className = "h-5 w-5",
}: {
  mode: string;
  className?: string;
}) {
  const m = (mode ?? "").toLowerCase();

  if (m.includes("walk")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className={className}>
        <circle cx={12} cy={4.5} r={2} />
        <path strokeLinecap="round" strokeLinejoin="round" d="m12 7-2.5 4.2 2.1 2.3m.4-6.5 3.8 2.6M11.1 13.5l-2 6m4.9-5.8 3.2 5.8" />
      </svg>
    );
  }
  if (m.includes("bike")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className={className}>
        <circle cx={6} cy={17} r={3.2} />
        <circle cx={18} cy={17} r={3.2} />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 8h3l2.1 4h-5.2m5.2 0H18m-6-4 2 4m-7 5 2.6-5h3.7" />
      </svg>
    );
  }
  if (m.includes("scooter")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className={className}>
        <circle cx={6} cy={18} r={2.8} />
        <circle cx={18} cy={18} r={2.8} />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 18h5.2l2.1-6H12m0 0V7.2h3.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className={className}>
      <rect x={4} y={10} width={16} height={6} rx={1.5} />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10V8.2A1.2 1.2 0 0 1 8.2 7h7.6A1.2 1.2 0 0 1 17 8.2V10" />
      <circle cx={8} cy={17} r={1.6} />
      <circle cx={16} cy={17} r={1.6} />
    </svg>
  );
}
