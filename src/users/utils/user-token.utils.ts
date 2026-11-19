import * as jwt from 'jsonwebtoken';

import { IUserToken } from '../interfaces/userToken.interface';
import { IAuthTokenResult } from '../interfaces/auth.interface';

export const userToken = (token: string): IUserToken | string => {
  try {
    const decode = jwt.verify(
      token,
      process.env.JWT_AUTH || '',
    ) as unknown as IAuthTokenResult;
    return {
      role: decode.role,
      sub: decode.sub,
      isExpired: false,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      const decoded = jwt.decode(token) as IAuthTokenResult | null;
      if (decoded?.sub) {
        return { role: decoded.role, sub: decoded.sub, isExpired: true };
      }
    }
    return 'Token no valido.';
  }
};
