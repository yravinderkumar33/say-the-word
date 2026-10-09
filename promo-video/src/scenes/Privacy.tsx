import { CanvasImage, staticFile } from "remotion";
import {
  C,
  Eyebrow,
  Headline,
  Lock,
  Reveal,
  Stage,
  useLayout,
} from "../design";

export const Privacy = () => {
  const { wide, margin } = useLayout();
  return (
    <Stage dark>
      <div
        style={{ position: "absolute", left: margin, top: wide ? 237 : 232 }}
      >
        <Reveal>
          <Eyebrow dark>Private by design</Eyebrow>
          <Headline dark>
            Your voice.
            <br />
            <span style={{ color: C.green }}>Your Mac.</span>
          </Headline>
        </Reveal>
        <Reveal
          delay={0.5}
          style={{
            fontSize: wide ? 40 : 40,
            color: "#C1D0C5",
            lineHeight: 1.3,
            marginTop: 38,
          }}
        >
          Speech recognition
          <br />
          happens on your Mac.
        </Reveal>
      </div>
      <div
        style={{
          position: "absolute",
          left: wide ? 1020 : 84,
          top: wide ? 245 : 699,
          width: wide ? 782 : 912,
        }}
      >
        <Reveal
          delay={0.25}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 23,
            marginBottom: 36,
          }}
        >
          <Lock size={50} />
          <div style={{ fontSize: wide ? 39 : 36, letterSpacing: -1 }}>
            Your words stay with you.
          </div>
        </Reveal>
        <Reveal
          delay={0.65}
          style={{
            border: "1px solid #526658",
            borderRadius: 22,
            padding: 18,
            background: "#1E1E20",
            boxShadow: "0 30px 65px #00000030",
          }}
        >
          <div
            style={{
              position: "relative",
              height: wide ? 267 : 306,
              overflow: "hidden",
              borderRadius: 10,
            }}
          >
            <CanvasImage
              src={staticFile("app/privacy-dark.png")}
              style={{
                position: "absolute",
                width: wide ? 1080 : 1255,
                maxWidth: "none",
                left: wide ? -284 : -330,
                top: wide ? -33 : -37,
              }}
            />
          </div>
        </Reveal>
        <Reveal
          delay={1.1}
          style={{ fontSize: 21, color: "#8CA294", marginTop: 19 }}
        >
          From the app’s Privacy screen
        </Reveal>
      </div>
      <Reveal
        delay={1.4}
        style={{
          position: "absolute",
          bottom: wide ? 136 : 112,
          left: margin,
          display: "flex",
          gap: wide ? 65 : 36,
          fontSize: wide ? 32 : 29,
          color: "#A5C5B0",
        }}
      >
        <span>No account</span>
        <span>·</span>
        <span>No telemetry</span>
        <span>·</span>
        <span>Open source</span>
      </Reveal>
    </Stage>
  );
};
