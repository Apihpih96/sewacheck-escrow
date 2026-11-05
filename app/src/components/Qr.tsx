"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function Qr({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((d) => alive && setSrc(d))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size]);
  return (
    <figure className="qr">
      {src ? (
        <img src={src} width={size} height={size} alt={label} />
      ) : (
        <div className="qr-placeholder" style={{ width: size, height: size }} />
      )}
      <figcaption>{label}</figcaption>
    </figure>
  );
}
