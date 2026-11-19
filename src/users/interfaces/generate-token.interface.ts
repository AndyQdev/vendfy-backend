import { JwtPayload, Secret, SignOptions } from 'jsonwebtoken';

export interface IGenerateToken {
  payload: JwtPayload;
  secret: Secret;
  expiresIn: SignOptions['expiresIn'];
}