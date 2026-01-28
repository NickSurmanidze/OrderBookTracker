import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'App is running! Go to localhost:3000 to access the UI.';
  }
}
