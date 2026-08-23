import type { MetadataRoute } from "next";

const origin = process.env.NEXT_PUBLIC_SITE_URL || "https://nort.works";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/admin/" },
    sitemap: `${origin}/sitemap.xml`,
  };
}
