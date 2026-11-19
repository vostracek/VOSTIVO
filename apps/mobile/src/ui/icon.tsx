import Svg, { Circle, Path, Rect } from "react-native-svg";
import { semantic } from "../design/tokens";

/**
 * Vostivo line icons — geometry copied verbatim from the approved Claude
 * Design canvases (`~/VostivoDesignArchive/athlete-v1/assets/icons/`, see
 * INDEX.md): 24px grid, round caps and joins, no fills (Foundations §14).
 * Navigation uses 21px at 1.7 stroke, rows 19px at 1.6. Icons label a
 * function — the caller always provides the accessible text next to them.
 */
export type IconName =
  | "today"
  | "plan"
  | "progress"
  | "profile"
  | "trainingProfile"
  | "account"
  | "about"
  | "privacy"
  | "equipment"
  | "clock"
  | "check"
  | "retry";

const glyphs: Record<IconName, React.JSX.Element> = {
  today: (
    <>
      <Path d="M12 3.5 4 9.2V20h16V9.2L12 3.5Z" />
      <Path d="M9.6 20v-6.2h4.8V20" />
    </>
  ),
  plan: (
    <>
      <Rect x={3.5} y={5} width={17} height={15.5} rx={2.2} />
      <Path d="M3.5 9.8h17M8.4 5V3.2M15.6 5V3.2" />
    </>
  ),
  progress: (
    <>
      <Path d="M4 17.2l4.6-5.1 3.3 2.6 4-5.2 4.1 3" />
      <Path d="M4 20.4h16" />
    </>
  ),
  profile: (
    <>
      <Circle cx={12} cy={8.6} r={3.7} />
      <Path d="M4.8 20.2c1.2-3.3 3.9-5 7.2-5s6 1.7 7.2 5" />
    </>
  ),
  trainingProfile: (
    <>
      <Circle cx={12} cy={12} r={8} />
      <Circle cx={12} cy={12} r={3.1} />
    </>
  ),
  account: (
    <>
      <Rect x={3.6} y={5.6} width={16.8} height={12.8} rx={2.2} />
      <Path d="M4.4 7.4 12 12.8l7.6-5.4" />
    </>
  ),
  about: (
    <>
      <Circle cx={12} cy={12} r={8.2} />
      <Path d="M10.2 9.6a1.9 1.9 0 1 1 2.9 1.7c-.7.4-1.1 1-1.1 1.8" />
      <Path d="M12 16.4h.01" />
    </>
  ),
  privacy: (
    <>
      <Path d="M12 3.6 5.4 6v6c0 4 2.8 7 6.6 8.4 3.8-1.4 6.6-4.4 6.6-8.4V6Z" />
      <Path d="M9.6 12.2l1.8 1.8 3.2-3.6" />
    </>
  ),
  equipment: <Path d="M3 12h2.2M18.8 12H21M5.2 9.2h1.9v5.6H5.2zM16.9 9.2h1.9v5.6h-1.9zM7.1 12h9.8" />,
  clock: (
    <>
      <Circle cx={12} cy={13} r={7.5} />
      <Path d="M12 9.5V13l2.4 1.6M9.5 3h5" />
    </>
  ),
  check: <Path d="M5 12.6l4.4 4.4L19 7.4" />,
  retry: <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
};

export function Icon({
  name,
  size = 19,
  strokeWidth = 1.6,
  color = semantic.textMuted,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
}): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {glyphs[name]}
    </Svg>
  );
}
