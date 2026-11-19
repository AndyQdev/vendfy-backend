import { Global, Module } from "@nestjs/common";
import { JsonHandlerService } from "./json-handler/json-handler.service";
import { LocalStorageService } from "./local-storage/local-storage.service";
import { PdfKitTableService } from "./pdfkit-table/pdfkit-table.service";
import { ExcelJsService } from "./exceljs/exceljs.service";
import { SupabaseStorageService } from "./supabase-storage/supabase-storage.service";

@Global()
@Module({
  imports: [],
  providers: [
    JsonHandlerService, 
    LocalStorageService, 
    ExcelJsService, 
    PdfKitTableService,
    SupabaseStorageService
  ],
  exports: [
    JsonHandlerService, 
    LocalStorageService, 
    ExcelJsService, 
    PdfKitTableService,
    SupabaseStorageService
  ],
})
export class ProvidersModule { }
