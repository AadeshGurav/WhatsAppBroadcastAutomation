import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineFactory } from './engine.factory';
import { BaileysAuthCreds } from '@database/entities/whatsapp/baileys-auth-creds.entity';
import { BaileysAuthKey } from '@database/entities/whatsapp/baileys-auth-key.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BaileysAuthCreds, BaileysAuthKey], 'data')],
  providers: [EngineFactory],
  exports: [EngineFactory],
})
export class EngineModule {}
