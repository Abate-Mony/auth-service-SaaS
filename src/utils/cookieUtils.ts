const isProduction = process.env.NODE_ENV == "production";
const ACCESS_TOKEN_COOKIE_MS = 15 * 60 * 1000;
export interface cookieObject {
  httpOnly: boolean;
  sameSite?: "lax" | "none" | "strict";
  expires: Date;
  secure: boolean;
}
export const setCookies = (time: number | null = ACCESS_TOKEN_COOKIE_MS): cookieObject => {
  const obj: cookieObject = {
    httpOnly: true,
    expires: time ? new Date(Date.now() + time) : new Date(Date.now()),
    secure: true,
    sameSite: isProduction ? "none" : "lax",
  };
  return {
    ...obj,
  };
};
