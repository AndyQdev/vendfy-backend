import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CompleteOauthDto {
  @ApiProperty({
    description:
      'Identificador temporal que WorkOS pasa al External Sign-in URI (query external_auth_id)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  external_auth_id: string;
}
