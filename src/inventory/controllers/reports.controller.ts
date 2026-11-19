import {
  Controller,
  Get,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from 'src/users/guards/auth.guard';
import { PermissionGuard } from 'src/users/guards/permission.guard';
import { PermissionAccess } from 'src/users/decorators/permissions.decorator';
import { GetUser } from 'src/users/decorators/get-user.decorator';
import { PERMISSION } from 'src/users/constants/permission.constant';
import { ResponseMessage } from 'src/common/interfaces';
import { ReportsService } from '../services/reports.service';
import { Funcion } from 'src/acceso/decoradores';

@ApiTags('Reports')
@UseGuards(AuthGuard, PermissionGuard)
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  private getDateFilter(period: string, startDate?: string, endDate?: string, storeId?: string, userId?: string) {
    const now = new Date();
    let start: Date;
    let end: Date = new Date(now);
    end.setHours(23, 59, 59, 999);

    switch (period) {
      case 'all':
        // Todo el historial: una fecha anterior a cualquier pedido posible.
        start = new Date(2000, 0, 1);
        break;
      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case '7days':
        start = new Date(now);
        start.setDate(start.getDate() - 6);
        start.setHours(0, 0, 0, 0);
        break;
      case '30days':
        start = new Date(now);
        start.setDate(start.getDate() - 29);
        start.setHours(0, 0, 0, 0);
        break;
      case 'thisMonth':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'custom':
        if (startDate && endDate) {
          start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
        } else {
          start = new Date(now);
          start.setDate(start.getDate() - 6);
          start.setHours(0, 0, 0, 0);
        }
        break;
      default:
        start = new Date(now);
        start.setDate(start.getDate() - 6);
        start.setHours(0, 0, 0, 0);
    }

    return { startDate: start, endDate: end, storeId, userId };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('kpis')
  async getKpis(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getKpis(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('sales-over-time')
  async getSalesOverTime(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.reportsService.getSalesOverTime(period, storeId, startDate, endDate, userId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Funcion('reportes')
  @Get('sales-by-category')
  async getSalesByCategory(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getSalesByCategory(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('orders-by-status')
  async getOrdersByStatus(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getOrdersByStatus(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('order-channels')
  async getOrderChannels(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getOrderChannels(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('sales-by-department')
  async getSalesByDepartment(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getSalesByDepartment(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('top-products')
  async getTopProducts(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getTopProducts(filter),
    };
  }

  /** El reporte de un producto: lo que muestra Estadísticas al escanearlo. */
  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'productId', required: true, type: 'string' })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Funcion('reportes')
  @Get('product')
  async getProductReport(
    @Query('productId', ParseUUIDPipe) productId: string,
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.reportsService.getProductReport(productId, period, storeId, startDate, endDate, userId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Get('low-stock')
  async getLowStock(
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.reportsService.getLowStock(storeId, userId),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Funcion('reportes')
  @Get('frequent-customers')
  async getFrequentCustomers(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getFrequentCustomers(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Funcion('reportes')
  @Get('sales-by-day')
  async getSalesByDay(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getSalesByDayAndHour(filter),
    };
  }

  @PermissionAccess(PERMISSION.SHOW_REPORTES)
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7days', '30days', 'thisMonth', 'all', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false, type: 'string' })
  @ApiQuery({ name: 'endDate', required: false, type: 'string' })
  @ApiQuery({ name: 'storeId', required: false, type: 'string' })
  @Funcion('reportes')
  @Get('financial-comparison')
  async getFinancialComparison(
    @Query('period') period = '7days',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @GetUser() userId?: string,
  ): Promise<ResponseMessage> {
    const filter = this.getDateFilter(period, startDate, endDate, storeId, userId);
    return {
      statusCode: 200,
      data: await this.reportsService.getFinancialComparison(filter),
    };
  }
}
