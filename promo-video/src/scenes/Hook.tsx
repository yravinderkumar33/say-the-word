import { interpolate, useCurrentFrame } from "remotion";
import {
  C,
  ease,
  Eyebrow,
  Headline,
  Pill,
  Reveal,
  Stage,
  useLayout,
} from "../design";

export const Hook = () => {
  const frame = useCurrentFrame();
  const { wide, width, margin, fps } = useLayout();
  return (
    <Stage dark>
      <div
        style={{
          position: "absolute",
          left: margin,
          top: wide ? 244 : 260,
          width: wide ? 1060 : 910,
        }}
      >
        <Reveal>
          <Eyebrow dark>Private dictation for Mac</Eyebrow>
        </Reveal>
        <Reveal delay={0.12}>
          <Headline dark size={wide ? 145 : 112}>
            Less typing.
          </Headline>
        </Reveal>
        <Reveal delay={0.55}>
          <Headline
            size={wide ? 145 : 112}
            style={{ color: C.green, marginTop: 6 }}
          >
            More thinking.
          </Headline>
        </Reveal>
        <Reveal
          delay={1.1}
          style={{
            fontSize: wide ? 43 : 42,
            color: "#B5C4B9",
            marginTop: 42,
            lineHeight: 1.25,
          }}
        >
          Turn your voice into text.
          <br />
          Keep your flow.
        </Reveal>
      </div>
      <div
        style={{
          position: "absolute",
          left: wide ? 1230 : 148,
          top: wide ? 290 : 820,
          width: wide ? 510 : 784,
          height: wide ? 510 : 270,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: wide ? 330 + i * 100 : 170 + i * 105,
              height: wide ? 330 + i * 100 : 170 + i * 105,
              border: "1px solid #4C7F5E",
              borderRadius: "50%",
              opacity: interpolate(
                frame,
                [0, 1.8 * fps],
                [0, 0.24 - i * 0.04],
                ease,
              ),
              scale: 1 + Math.sin(frame * 0.025 - i) * 0.035,
            }}
          />
        ))}
        <Reveal delay={0.7} style={{ scale: wide ? 1.9 : 1.65 }}>
          <Pill />
        </Reveal>
      </div>
      <Reveal
        delay={1.7}
        style={{
          position: "absolute",
          left: margin,
          bottom: wide ? 113 : 127,
          fontSize: 25,
          color: "#B2C1B7",
          letterSpacing: 0.6,
        }}
      >
        ON-DEVICE SPEECH · OPEN SOURCE
      </Reveal>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          height: 5,
          background: C.green,
          width: interpolate(frame, [0, 4.8 * fps], [0, width], ease),
        }}
      />
    </Stage>
  );
};
