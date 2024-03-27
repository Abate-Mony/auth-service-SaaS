export type productStatesType = "pending" | "recieve" | "sent";
export type UserroleTypes = "admin" | "user" | "moderator";
interface IUserTypes {
  [key: string | number]: UserroleTypes;
}
interface IProductStates {
  [key: string | number]: productStatesType;
}
export const USER_ROLES: IUserTypes = {
  admin: "admin",
  user: "user",
  moderator: "moderator",
};
export const PRODUCT_STATES :IProductStates = {
  pending: "pending",
  recieve:"recieve",
  sent:"sent"
};
