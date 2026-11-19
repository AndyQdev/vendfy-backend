export interface IUser {
  name: string;
  email: string;
  password: string;
  phoneNumber?: string;
  roleId: string;
  storeId?: string;
}
