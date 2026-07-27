import satoyamaLogoUrl from '../../assets/satoyama-logo-mark.png';

export function SatoyamaBrandLogo() {
  return (
    <img
      className="brand-logo"
      src={satoyamaLogoUrl}
      alt="SATOYAMA AI BASE"
      width={512}
      height={512}
      decoding="async"
    />
  );
}
