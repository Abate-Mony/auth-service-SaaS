const isProduction = process.env.NODE_ENV == "production";
export interface cookieObject {
  httpOnly: boolean;
  sameSite?: "lax" | "none" | "strict";
  expires: Date;
  secure: boolean;
}
export const setCookies = (time: number = null): cookieObject => {
  const obj: cookieObject = {
    httpOnly: isProduction,
    expires: time ? new Date(Date.now() + time) : new Date(Date.now()),
    secure: isProduction,
  };
  if (isProduction) obj.sameSite = "none";
  return {
    ...obj,
  };
};
