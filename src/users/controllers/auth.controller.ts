import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger/dist/decorators';
import { Request } from 'express';

import { LibreParaEquipo } from 'src/acceso/decoradores';
import { CambiarClaveDto } from 'src/acceso/dto/equipo.dto';
import { AuthGuard } from '../guards/auth.guard';

import { AuthDTO } from '../dto/auth.dto';
import { RegisterDto } from '../dto/register.dto';
import { AuthService } from '../services/auth.service';
import { ResponseMessage } from '../../common/interfaces';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {

  constructor(private readonly authService: AuthService) { }

  @Post('login')
  public async login(@Body() authDto: AuthDTO): Promise<ResponseMessage> {
    const { email, password } = authDto;
    return {
      statusCode: 200,
      data: await this.authService.login(email, password),
    };
  }

  @Post('register')
  public async register(
    @Body() registerDto: RegisterDto
  ): Promise<ResponseMessage> {
    return {
      statusCode: 201,
      message: 'Usuario registrado exitosamente',
      data: await this.authService.register(registerDto),
    };
  }

  @ApiQuery({ name: 'token', type: 'string', required: true })
  @Get('checkToken')
  public async checkToken(@Query('token') token: string): Promise<ResponseMessage> {
    return {
      statusCode: 200,
      data: await this.authService.checkToken(token)
    };
  }

  /**
   * La persona cambia su contraseña. Es lo primero que hace un empleado al
   * entrar con la contraseña inicial que le dio el dueño.
   */
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @LibreParaEquipo()
  @Post('cambiar-clave')
  public async cambiarClave(@Req() req: Request, @Body() dto: CambiarClaveDto): Promise<ResponseMessage> {
    return { statusCode: 200, data: await this.authService.cambiarClave(req.actorId, dto.actual, dto.nueva) };
  }

  // @Post('forgot-password')
  // public async requestPasswordForgot(@Body() sendEmailDTO: SendEmailDTO): Promise<ResponseMessage> {
  // }

  // @Get('checkToken-password/:token')
  // public async requestPasswordCheckToken(@Param() param): Promise<ResponseMessage> {
  // }

  // @Post('reset-password')
  // public async requestPasswordReset(@Body() resetpasswordDto: ResetPasswordDTO): Promise<ResponseMessage> {
  // }
}
