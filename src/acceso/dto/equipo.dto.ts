import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CambiarClaveDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  actual: string;

  @ApiProperty({ description: 'Al menos 8 caracteres' })
  @IsString()
  @MinLength(8, { message: 'La contraseña tiene que tener al menos 8 caracteres' })
  @MaxLength(72)
  nueva: string;
}

export class CrearMiembroDto {
  @ApiProperty({ example: 'María Quispe' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'maria@minimarket.com' })
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(100)
  email: string;

  @ApiPropertyOptional({ example: '71234567' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional({ example: '+591' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  countryCode?: string;

  @ApiProperty({ description: 'Rol de empleado: uno de Vendfy o uno del negocio' })
  @IsUUID()
  roleId: string;

  @ApiProperty({ type: [String], description: 'Sucursales en que trabaja (al menos una)' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Elegí al menos una sucursal' })
  @IsUUID('all', { each: true })
  storeIds: string[];

  @ApiProperty({ description: 'Contraseña inicial: la cambia al entrar' })
  @IsString()
  @MinLength(8, { message: 'La contraseña tiene que tener al menos 8 caracteres' })
  @MaxLength(72)
  password: string;
}

export class EditarMiembroDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Elegí al menos una sucursal' })
  @IsUUID('all', { each: true })
  storeIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ description: 'Nueva contraseña inicial (la vuelve a cambiar al entrar)' })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'La contraseña tiene que tener al menos 8 caracteres' })
  @MaxLength(72)
  password?: string;
}

export class RolDto {
  @ApiProperty({ example: 'Cajero de la tarde' })
  @IsString()
  @MinLength(3)
  @MaxLength(70)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  descripcion?: string;

  @ApiProperty({ type: [String], description: 'Nombres de los permisos (ver /equipo/catalogo)' })
  @IsArray()
  @IsString({ each: true })
  permisos: string[];
}

export class EditarRolDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(70)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  descripcion?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permisos?: string[];
}

// ---------------------------------------------------------------- SuperAdmin

export class PlanDto {
  @ApiProperty({ example: 'negocio' })
  @IsString()
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'El código va en minúsculas, números y guiones' })
  codigo: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  nombre: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  precioMensual: number;

  @ApiProperty({ description: '{ tiendas, usuarios, consultasAsistente, facturas }; sin valor = ilimitado' })
  @IsObject()
  limites: Record<string, number | null>;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  funciones: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  orden?: number;
}

export class EditarPlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  nombre?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  precioMensual?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  limites?: Record<string, number | null>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  funciones?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  orden?: number;
}

export class SuscripcionDto {
  @ApiProperty()
  @IsUUID()
  planId: string;

  @ApiPropertyOptional({ description: 'Lo que paga este negocio; vacío = el precio del plan' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  precioMensual?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fundador?: boolean;

  @ApiPropertyOptional({ example: '2026-11-16' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desde?: string | null;

  @ApiPropertyOptional({ example: '2027-11-16' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hasta?: string | null;

  @ApiPropertyOptional({ enum: ['activa', 'suspendida'] })
  @IsOptional()
  @IsIn(['activa', 'suspendida'])
  estado?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  funcionesExtra?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  funcionesQuitadas?: string[];

  @ApiPropertyOptional({ description: 'Límites propios de este negocio; null = ilimitado' })
  @IsOptional()
  @IsObject()
  limitesExtra?: Record<string, number | null>;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  notas?: string | null;
}

export class ActivoDto {
  @ApiProperty()
  @IsBoolean()
  activo: boolean;
}
