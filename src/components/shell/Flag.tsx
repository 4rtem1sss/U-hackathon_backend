/** Inline SVG flags: Windows Chrome draws flag emoji as plain letters. */
export function Flag({ country, className }: { country: "TH" | "US"; className?: string }) {
  const frame = "h-3.5 w-5 shrink-0 overflow-hidden rounded-[2px] ring-1 ring-black/10";
  if (country === "TH") {
    return (
      <svg viewBox="0 0 9 6" aria-hidden className={`${frame} ${className ?? ""}`}>
        <rect width="9" height="6" fill="#A51931" />
        <rect y="1" width="9" height="4" fill="#F4F5F8" />
        <rect y="2" width="9" height="2" fill="#2D2A4A" />
      </svg>
    );
  }
  const stripe = 10 / 13;
  return (
    <svg viewBox="0 0 19 10" aria-hidden className={`${frame} ${className ?? ""}`}>
      <rect width="19" height="10" fill="#FFFFFF" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={i * 2 * stripe} width="19" height={stripe} fill="#B22234" />
      ))}
      <rect width="7.6" height={7 * stripe} fill="#3C3B6E" />
    </svg>
  );
}
