import { useCurrentFrame } from "remotion";
import {
  C,
  Eyebrow,
  Headline,
  Key,
  Pill,
  Reveal,
  Stage,
  useLayout,
} from "../design";

export const HandsFree = () => {
  const frame = useCurrentFrame();
  const { fps, wide, margin } = useLayout();
  return (
    <Stage bg={C.pale}>
      <div
        style={{ position: "absolute", left: margin, top: wide ? 252 : 240 }}
      >
        <Reveal>
          <Eyebrow>Room for a longer thought</Eyebrow>
          <Headline>
            Give your
            <br />
            hands a break.
          </Headline>
        </Reveal>
        <Reveal
          delay={0.4}
          style={{
            fontSize: wide ? 42 : 42,
            lineHeight: 1.3,
            marginTop: 43,
            color: "#41604C",
          }}
        >
          Press fn twice.
          <br />
          Keep the ideas coming.
        </Reveal>
      </div>
      <div
        style={{
          position: "absolute",
          left: wide ? 1180 : 205,
          top: wide ? 320 : 783,
          width: wide ? 510 : 670,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 36,
        }}
      >
        <Reveal delay={0.35}>
          <Key
            size={wide ? 174 : 154}
            pressed={frame > 0.7 * fps && frame < 0.9 * fps}
          />
        </Reveal>
        <Reveal delay={0.55}>
          <Key
            size={wide ? 174 : 154}
            pressed={frame > 1 * fps && frame < 1.2 * fps}
          />
        </Reveal>
      </div>
      <Reveal
        delay={1.25}
        style={{
          position: "absolute",
          left: wide ? 1267 : 335,
          top: wide ? 606 : 1040,
        }}
      >
        <Pill handsFree scale={1.35} />
      </Reveal>
      <Reveal
        delay={1.5}
        style={{
          position: "absolute",
          left: margin,
          bottom: wide ? 106 : 112,
          fontSize: 26,
          color: "#577460",
        }}
      >
        Hands-free dictation · press fn again to finish
      </Reveal>
    </Stage>
  );
};
