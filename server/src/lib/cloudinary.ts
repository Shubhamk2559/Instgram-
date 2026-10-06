import crypto from "crypto";
import { env } from "../config/env";

function sign(params: Record<string, string | number>): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + env.CLOUDINARY_API_SECRET).digest("hex");
}

// Lets the browser upload straight to Cloudinary without exposing our secret.
export function signUpload(folder: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    folder,
    signature: sign({ folder, timestamp }),
  };
}

// Best-effort cleanup when a reel is deleted.
export async function destroyAsset(publicId: string, resourceType: "video" | "image"): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: env.CLOUDINARY_API_KEY,
    signature: sign({ public_id: publicId, timestamp }),
  });
  await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/destroy`, {
    method: "POST",
    body,
  }).catch(() => {});
}
