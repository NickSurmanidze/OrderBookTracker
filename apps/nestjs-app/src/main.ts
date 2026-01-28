import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Enable WebSocket adapter
  app.useWebSocketAdapter(new IoAdapter(app));

  // Enable CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);

  logger.log(`🚀 NestJS app is running on: http://localhost:${port}`);
  logger.log(
    `🌐 WebSocket server is running on: ws://localhost:${port}/market-data`,
  );
}
void bootstrap();
