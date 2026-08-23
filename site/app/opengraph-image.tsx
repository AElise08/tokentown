import { ImageResponse } from "next/og";
import { citySvg } from "@/lib/city";

export const alt = "NORTOWN — where prompts become skyline";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const city = citySvg(
    { username: "nortown", tokens: 2_400_000, residents: 44, buildings: 1280 },
    "full"
  );
  const cityUri = `data:image/svg+xml;base64,${Buffer.from(city).toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 64,
        color: "#e8f2fb",
        background: "#07111f",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg width="42" height="42" viewBox="0 0 24 24">
          <path d="M12 0l2.15 9.85L24 12l-9.85 2.15L12 24l-2.15-9.85L0 12l9.85-2.15L12 0z" fill="#77bfff" />
          <circle cx="12" cy="12" r="2" fill="#07111f" />
        </svg>
        <div style={{ display: "flex", fontSize: 58, fontWeight: 800, letterSpacing: 8 }}>NORTOWN</div>
      </div>
      <div style={{ display: "flex", height: 285, border: "2px solid #365876", borderRadius: 18, overflow: "hidden" }}>
        <img src={cityUri} width={1072} height={285} alt="A blue pixel skyline at night" />
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", color: "#d5edff", fontSize: 34, fontWeight: 700 }}>where prompts become skyline</div>
          <div style={{ display: "flex", color: "#91a8bb", fontSize: 22 }}>Every AI token becomes part of a living pixel city.</div>
        </div>
        <div style={{ display: "flex", color: "#6ce5ee", fontSize: 24 }}>nort.works</div>
      </div>
    </div>,
    size
  );
}
