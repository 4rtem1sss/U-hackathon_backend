import Image from "next/image";

/** Wordmark from assets/logo (copied to public/brand in Task 1). Source is 994x354. */
export function Logo() {
  return <Image src="/brand/centme-wordmark.png" alt="CentMe" width={994} height={354} priority className="h-9 w-auto" />;
}
