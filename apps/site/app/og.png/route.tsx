import { ImageResponse } from "next/og";

// A route handler named og.png rather than Next's opengraph-image convention: under
// `output: "export"` that convention writes a file with no extension (`out/opengraph-image`),
// which a static server sends as application/octet-stream. This one lands as `out/og.png`.
export const dynamic = "force-static";

const size = { width: 1200, height: 630 };

const ink = "#17201c";
const soft = "#4b5751";
const thread = "#c3ccc6";

function Bullet({ size: s, color = ink }: { size: number; color?: string }) {
  return <div style={{ width: s, height: s, borderRadius: s, background: color, flexShrink: 0 }} />;
}

function Row({ indent, text, color }: { indent: number; text: string; color?: string }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 22, marginLeft: indent, marginTop: 18 }}
    >
      <Bullet size={12} color={color ?? soft} />
      <div style={{ fontSize: 34, color: soft }}>{text}</div>
    </div>
  );
}

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#f2f4f1",
        padding: "84px 96px",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 140,
          bottom: 0,
          width: 2,
          background: thread,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
        <Bullet size={30} />
        <div style={{ fontSize: 76, fontWeight: 700, color: ink, letterSpacing: -2 }}>nooklet</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginLeft: 60, marginTop: 26 }}>
        <div style={{ fontSize: 46, color: ink, letterSpacing: -1, lineHeight: 1.2 }}>
          Your notes, in bullets, on your own machines.
        </div>
        <Row indent={0} text="An outliner like Logseq, with a markdown mirror" />
        <Row
          indent={0}
          text="Every device works offline and syncs through your server"
          color="#3245a6"
        />
        <Row
          indent={0}
          text="Agents read and edit it over MCP, one bullet at a time"
          color="#8f5300"
        />
      </div>
    </div>,
    size,
  );
}
