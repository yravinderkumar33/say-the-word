import { interpolate, useCurrentFrame } from "remotion";
import {
  C,
  ease,
  Headline,
  Key,
  Pill,
  Reveal,
  Stage,
  useLayout,
} from "../design";

export const Demo = () => {
  const frame = useCurrentFrame();
  const { fps, wide, margin } = useLayout();
  const held = frame >= 0.9 * fps && frame < 5.4 * fps;
  const pasted = frame >= 5.95 * fps;
  const phrase = "Let’s move the meeting to Friday at 3.";
  const spoken = phrase
    .split(" ")
    .slice(
      0,
      Math.floor(interpolate(frame, [1.35 * fps, 4.4 * fps], [0, 9], ease)),
    )
    .join(" ");
  const cardW = wide ? 890 : 912;
  return (
    <Stage>
      <div
        style={{ position: "absolute", left: margin, top: wide ? 232 : 222 }}
      >
        <Reveal>
          <Headline>
            Hold. Speak.
            <br />
            Release.
          </Headline>
        </Reveal>
        <Reveal
          delay={0.25}
          style={{
            position: "absolute",
            top: wide ? 307 : 272,
            display: "flex",
            alignItems: "center",
            gap: 27,
            width: wide ? 730 : 900,
          }}
        >
          <Key size={wide ? 114 : 88} pressed={held} />
          <div
            style={{
              fontSize: wide ? 35 : 36,
              lineHeight: 1.22,
              color: "#526459",
            }}
          >
            {pasted ? (
              <>
                Right where
                <br />
                your cursor is.
              </>
            ) : held ? (
              <>
                Speak naturally.
                <br />
                We’re listening.
              </>
            ) : frame < fps ? (
              <>
                Hold fn
                <br />
                to start.
              </>
            ) : (
              <>
                Release fn.
                <br />
                Your words arrive.
              </>
            )}
          </div>
        </Reveal>
      </div>
      <div
        style={{
          position: "absolute",
          left: wide ? 930 : 84,
          top: wide ? 220 : 698,
          width: cardW,
        }}
      >
        <Reveal delay={0.1}>
          <div
            style={{
              borderRadius: 24,
              background: C.white,
              boxShadow: "0 28px 85px #2133291B",
              border: "1px solid #DCE2DC",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: 66,
                background: "#EBEEE9",
                display: "flex",
                alignItems: "center",
                padding: "0 28px",
                gap: 9,
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#FF6057",
                }}
              />
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#FFBD2E",
                }}
              />
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#28C840",
                }}
              />
              <div style={{ marginLeft: 28, fontSize: 24, color: "#5C685F" }}>
                New message
              </div>
            </div>
            <div
              style={{
                padding: "27px 38px 0",
                fontSize: 24,
                color: "#758176",
                borderBottom: "1px solid #EEF0EB",
                height: 65,
              }}
            >
              To: <span style={{ color: C.ink, marginLeft: 15 }}>The team</span>
            </div>
            <div
              style={{
                padding: "30px 38px",
                height: wide ? 250 : 243,
                fontSize: 44,
                lineHeight: 1.35,
                letterSpacing: -1,
              }}
            >
              {pasted ? (
                <span
                  style={{
                    background: frame < 6.45 * fps ? "#E7F6E9" : "transparent",
                  }}
                >
                  {phrase}
                </span>
              ) : (
                <span
                  style={{
                    display: "inline-block",
                    width: 3,
                    height: 46,
                    background: "#208548",
                    opacity: Math.floor(frame / 15) % 2 ? 0.2 : 1,
                  }}
                />
              )}
            </div>
          </div>
        </Reveal>
        <div
          style={{
            position: "absolute",
            top: wide ? 430 : 415,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: interpolate(
              frame,
              [0.5 * fps, 0.9 * fps, 6.5 * fps, 7 * fps],
              [0, 1, 1, 0],
              ease,
            ),
          }}
        >
          <Pill listening={held} processing={frame >= 5.4 * fps && !pasted} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: wide ? 952 : 94,
          top: wide ? 845 : 616,
          width: wide ? 846 : 890,
          textAlign: wide ? "left" : "center",
          fontSize: wide ? 37 : 31,
          lineHeight: 1.3,
          color: "#438A5D",
          opacity: interpolate(
            frame,
            [1.1 * fps, 1.4 * fps, 5.35 * fps, 5.65 * fps],
            [0, 1, 1, 0],
            ease,
          ),
        }}
      >
        “{spoken}”
      </div>
      <div
        style={{
          position: "absolute",
          left: margin,
          bottom: wide ? 78 : 91,
          fontSize: 20,
          color: "#7D877F",
        }}
      >
        Illustrative workflow · text appears after you release the key
      </div>
    </Stage>
  );
};
