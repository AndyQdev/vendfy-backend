import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength, MinLength, } from 'class-validator';

export class CreatePermissionDto {
  @ApiProperty({
    example: 'usuario',
    type: String,
    description: 'Nombre del permiso, solo lo usa el sistema',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(70)
  name: string;

  @ApiProperty({
    example: 'Gestionar Usuarios',
    type: String,
    description: 'Descripcion del permiso, lo que ve el usuario',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(70)
  description: string;

  @ApiProperty({
    example: 'Iventario',
    type: String,
    description: 'Tipo de permiso que se esta creando',
  })
  type: string
}

export class UpdatePermissionDto extends PartialType(CreatePermissionDto) { }


export class CreatePermissionRoleDto {
  @ApiProperty({
    example: '1b742c01-6dd2-47d2-8959-7d93f44ea86e(ejemplo)',
    type: String,
    description: 'Id del permiso',
  })
  @IsNotEmpty()
  @IsString()
  @IsUUID()
  permission: string;

  @ApiProperty({
    example: '1b742c01-6dd2-47d2-8959-7d93f44ea86e(ejemplo)',
    type: String,
    description: 'Id del rol',
  })
  @IsNotEmpty()
  @IsString()
  @IsUUID()
  role: string;
}
