import { Type } from "class-transformer";
import { IsEnum, IsOptional, IsPositive, IsString, IsUUID, Min, IsIn } from "class-validator";
import { ORDER, ORDER_ENUM } from "../constants/order";

export class QueryDto {
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @Min(0)
  @Type(() => Number)
  offset?: number;

  @IsOptional()
  @IsEnum(ORDER_ENUM)
  order?: ORDER;

  @IsString()
  @IsOptional()
  attr?: string;

  @IsOptional()
  value?: string;

  @IsOptional()
  @IsUUID()
  storeId?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year'])
  dateFilter?: 'day' | 'week' | 'month' | 'year';

  @IsOptional()
  @IsString()
  status?: string;

  /** Solo lo que tiene este producto (lo escaneado en Ventas o Pedidos). */
  @IsOptional()
  @IsUUID()
  productId?: string;
}
