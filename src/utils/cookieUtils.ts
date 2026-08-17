const isProduction = process.env.NODE_ENV == "production";
export interface cookieObject {
  httpOnly: boolean;
  sameSite?: "lax" | "none" | "strict";
  expires: Date;
  secure: boolean;
}
export const setCookies = (time: number | null = 0): cookieObject => {
  const obj: cookieObject = {
    httpOnly: true,
    expires: time ? new Date(Date.now() + time) : new Date(Date.now()),
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  };
  return {
    ...obj,
  };
};
