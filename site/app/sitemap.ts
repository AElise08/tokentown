import type { MetadataRoute } from "next";

const origin = process.env.NEXT_PUBLIC_SITE_URL || "https://nort.works";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: origin, changeFrequency: "hourly", priority: 1 },
    { url: `${origin}/privacy`, changeFrequency: "monthly", priority: 0.3 },
  ];
}
