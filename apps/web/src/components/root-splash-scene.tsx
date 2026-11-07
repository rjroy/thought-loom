import { useId, type Ref } from "react";

/** Exact supplied reveal geometry and approved timing; both images are full scenes. */
export function RootSplashScene({ sceneRef, completeRef, className, onError }: {
  sceneRef: Ref<SVGSVGElement>;
  completeRef: Ref<SVGImageElement>;
  className: string;
  onError: () => void;
}) {
  const id = useId();
  const soft = `${id}-soft`, hold = `${id}-hold`, outside = `${id}-outside`, reveal = `${id}-reveal`;
  return (
    <svg ref={sceneRef} className={className} viewBox="0 0 1536 1024" aria-hidden="true" focusable="false">
      <defs>
        <filter id={soft} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation="3" /></filter>
        <radialGradient id={hold}><stop offset="60%" stopColor="black" /><stop offset="100%" stopColor="white" /></radialGradient>
        <mask id={outside} maskUnits="userSpaceOnUse" x="0" y="0" width="1536" height="1024">
          <rect width="1536" height="1024" fill="white" /><circle cx="815" cy="412" r="140" fill={`url(#${hold})`} />
        </mask>
        <mask id={reveal} maskUnits="userSpaceOnUse" x="0" y="0" width="1536" height="1024" style={{ maskType: "luminance" }}>
          <rect width="1536" height="1024" fill="black" />
          <g mask={`url(#${outside})`}>
            <g fill="none" stroke="white" strokeWidth="72" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${soft})`}>
              <path data-start="0.23" data-duration="0.35" d="M434 562 L493 490 L526 409 L572 372 L667 347 L692 300" />
              <path data-start="0.34360655737704915" data-duration="0.35" d="M493 490 L590 497" />
              <path data-start="0.4509016393442623" data-duration="0.35" d="M653 519 L675 529 L752 458" />
              <path data-start="0.4887704918032787" data-duration="0.35" d="M750 275 L850 298 L910 245 L934 200" />
              <path data-start="0.5518852459016393" data-duration="0.35" d="M667 347 L745 405 M850 298 L839 348" />
              <path data-start="0.6528688524590164" data-duration="0.35" d="M890 413 L960 395 L1003 398" />
              <path data-start="0.7475409836065573" data-duration="0.35" d="M1047 335 L1100 291" />
              <path data-start="0.7790983606557377" data-duration="0.35" d="M1003 398 L1075 439 L1095 449" />
              <path data-start="0.8611475409836065" data-duration="0.35" d="M1155 267 L1204 256 L1265 228" />
              <path data-start="0.987377049180328" data-duration="0.35" d="M1311 177 L1360 135 L1394 119" />
              <path data-start="0.9368852459016394" data-duration="0.35" d="M1160 440 L1228 390 L1274 372" />
              <path data-start="1.0" data-duration="0.35" d="M1140 480 L1204 510 L1252 522" />
              <path data-start="0.6781147540983606" data-duration="0.35" d="M977 174 L1010 149 L1054 131" />
            </g>
            <g fill="white" filter={`url(#${soft})`}>
              <circle data-start="0.15" data-duration="0.35" cx="470" cy="515" r="68" />
              <circle data-start="0.26409395973154365" data-duration="0.35" cx="535" cy="378" r="86" />
              <circle data-start="0.3667785234899329" data-duration="0.35" cx="627" cy="497" r="82" />
              <circle data-start="0.4124161073825503" data-duration="0.35" cx="710" cy="268" r="91" />
              <circle data-start="0.5550335570469799" data-duration="0.35" cx="946" cy="173" r="84" />
              <circle data-start="0.6463087248322147" data-duration="0.35" cx="1003" cy="359" r="96" />
              <circle data-start="0.7432885906040269" data-duration="0.35" cx="1120" cy="263" r="83" />
              <circle data-start="0.7832214765100671" data-duration="0.35" cx="1128" cy="449" r="85" />
              <circle data-start="0.8516778523489933" data-duration="0.35" cx="1280" cy="203" r="85" />
              <circle data-start="0.9258389261744966" data-duration="0.35" cx="1292" cy="359" r="83" />
              <circle data-start="0.9771812080536912" data-duration="0.35" cx="1278" cy="525" r="76" />
              <circle data-start="1.0" data-duration="0.35" cx="1417" cy="99" r="87" />
            </g>
          </g>
          <circle data-center="true" data-start="1.15" data-duration="0.5" cx="815" cy="412" r="129" fill="white" filter={`url(#${soft})`} />
        </mask>
      </defs>
      <image href="/backgrounds/splash-landscape.webp" width="1536" height="1024" onError={onError} />
      <image ref={completeRef} href="/backgrounds/splash-complete.webp" width="1536" height="1024" mask={`url(#${reveal})`} onError={onError} />
    </svg>
  );
}
