import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  /** Rendered logo height in px */
  height?: number;
  href?: string | null;
  priority?: boolean;
};

export function BrandLogo({
  className,
  height = 30,
  href = "/live",
  priority = false,
}: BrandLogoProps) {
  const img = (
    <Image
      src="/crosstown-logo.png"
      alt="Crosstown"
      width={1024}
      height={269}
      priority={priority}
      className={cn(
        "block h-auto w-auto max-w-[min(62vw,240px)] object-contain object-left",
        className,
      )}
      style={{ height }}
    />
  );

  if (href) {
    return (
      <Link href={href} className="inline-flex shrink-0 items-center" aria-label="Crosstown home">
        {img}
      </Link>
    );
  }

  return img;
}
