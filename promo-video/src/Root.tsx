import {
  AbsoluteFill,
  Composition,
  Folder,
  Series,
  Still,
  staticFile,
  useVideoConfig,
} from "remotion";
import { Audio } from "@remotion/media";
import { Hook } from "./scenes/Hook";
import { Demo } from "./scenes/Demo";
import { Cleanup } from "./scenes/Cleanup";
import { Privacy } from "./scenes/Privacy";
import { HandsFree } from "./scenes/HandsFree";
import { Close } from "./scenes/Close";
import { Poster } from "./Poster";

export type FilmProps = { music: boolean };
export const Film = ({ music }: FilmProps) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Series>
        <Series.Sequence
          name="01 — Less typing, more thinking"
          durationInFrames={4.8 * fps}
          premountFor={fps}
        >
          <Hook />
        </Series.Sequence>
        <Series.Sequence
          name="02 — Hold, speak, release"
          durationInFrames={8.4 * fps}
          premountFor={fps}
        >
          <Demo />
        </Series.Sequence>
        <Series.Sequence
          name="03 — Optional local cleanup"
          durationInFrames={6 * fps}
          premountFor={fps}
        >
          <Cleanup />
        </Series.Sequence>
        <Series.Sequence
          name="04 — Your voice, your Mac"
          durationInFrames={6 * fps}
          premountFor={fps}
        >
          <Privacy />
        </Series.Sequence>
        <Series.Sequence
          name="05 — Hands-free"
          durationInFrames={4.8 * fps}
          premountFor={fps}
        >
          <HandsFree />
        </Series.Sequence>
        <Series.Sequence
          name="06 — Say the Word"
          durationInFrames={6 * fps}
          premountFor={fps}
        >
          <Close />
        </Series.Sequence>
      </Series>
      {music && <Audio src={staticFile("audio/score.wav")} premountFor={fps} />}
    </AbsoluteFill>
  );
};

export const RemotionRoot = () => (
  <>
    <Composition
      id="SayTheWord-Feed"
      component={Film}
      durationInFrames={1080}
      fps={30}
      width={1080}
      height={1350}
      defaultProps={{ music: true }}
    />
    <Composition
      id="SayTheWord-Landscape"
      component={Film}
      durationInFrames={1080}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ music: true }}
    />
    <Still id="Cover-Feed" component={Poster} width={1080} height={1350} />
    <Still id="Cover-Landscape" component={Poster} width={1920} height={1080} />
    <Folder name="Scenes">
      <Composition
        id="Hook"
        component={Hook}
        durationInFrames={144}
        fps={30}
        width={1080}
        height={1350}
      />
      <Composition
        id="Demo"
        component={Demo}
        durationInFrames={252}
        fps={30}
        width={1080}
        height={1350}
      />
      <Composition
        id="Cleanup"
        component={Cleanup}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1350}
      />
      <Composition
        id="Privacy"
        component={Privacy}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1350}
      />
      <Composition
        id="HandsFree"
        component={HandsFree}
        durationInFrames={144}
        fps={30}
        width={1080}
        height={1350}
      />
      <Composition
        id="Close"
        component={Close}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1350}
      />
    </Folder>
  </>
);
