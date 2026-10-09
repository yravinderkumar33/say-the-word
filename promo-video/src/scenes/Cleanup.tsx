import { interpolate, useCurrentFrame } from "remotion";
import {
  C,
  ease,
  Eyebrow,
  Headline,
  Reveal,
  Stage,
  useLayout,
} from "../design";

export const Cleanup = () => {
  const frame = useCurrentFrame();
  const { wide, margin, fps } = useLayout();
  const cleaned = frame > 2 * fps;
  return (
    <Stage>
      <div
        style={{ position: "absolute", left: margin, top: wide ? 245 : 226 }}
      >
        <Reveal>
          <Eyebrow>Optional local cleanup</Eyebrow>
          <Headline>
            Your words.
            <br />A little tidier.
          </Headline>
        </Reveal>
        {wide && (
          <Reveal
            delay={0.5}
            style={{
              fontSize: 42,
              lineHeight: 1.3,
              color: "#5D6E62",
              marginTop: 44,
            }}
          >
            Less “um”.
            <br />
            Same intention.
          </Reveal>
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: wide ? 1030 : 84,
          top: wide ? 215 : 563,
          width: wide ? 778 : 912,
        }}
      >
        <Reveal
          delay={0.3}
          style={{ padding: 36, background: "#E8EBE4", borderRadius: 24 }}
        >
          <div
            style={{
              fontSize: 21,
              letterSpacing: 2,
              color: "#6C776B",
              marginBottom: 22,
            }}
          >
            YOU SAY
          </div>
          <div style={{ fontSize: 44, lineHeight: 1.35, letterSpacing: -1 }}>
            <span
              style={{
                color: cleaned ? "#929A90" : C.ink,
                textDecoration: cleaned ? "line-through" : "none",
              }}
            >
              Um,{" "}
            </span>
            let’s meet Friday at 3 PM and{" "}
            <span
              style={{
                color: cleaned ? "#929A90" : C.ink,
                textDecoration: cleaned ? "line-through" : "none",
              }}
            >
              uh{" "}
            </span>
            bring the report.
          </div>
        </Reveal>
        <div
          style={{
            height: 58,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 36,
            color: "#87A38A",
          }}
        >
          ↓
        </div>
        <Reveal
          delay={1.7}
          style={{
            padding: 36,
            background: "#FFFFFF",
            border: "2px solid #A8CEAF",
            boxShadow: "0 17px 45px #2235290B",
            borderRadius: 24,
          }}
        >
          <div
            style={{
              fontSize: 21,
              letterSpacing: 2,
              color: "#35774A",
              marginBottom: 22,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            CLEANED <span>✓</span>
          </div>
          <div
            style={{
              fontSize: 44,
              lineHeight: 1.35,
              letterSpacing: -1,
              opacity: interpolate(frame, [1.8 * fps, 2.5 * fps], [0, 1], ease),
            }}
          >
            Let’s meet Friday at 3 PM and bring the report.
          </div>
        </Reveal>
      </div>
      <Reveal
        delay={2.4}
        style={{
          position: "absolute",
          left: margin,
          bottom: wide ? 90 : 91,
          fontSize: wide ? 28 : 27,
          color: "#607265",
        }}
      >
        Cleaned mode uses Ollama running on your Mac.
      </Reveal>
    </Stage>
  );
};
