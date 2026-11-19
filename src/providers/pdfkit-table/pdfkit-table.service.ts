import { Injectable, Logger } from "@nestjs/common";
import { JsonHandlerService } from "../json-handler/json-handler.service";
import { PdfOptions } from "./pdf-options.interface";
import { titleStyle } from "./style";
import { handlerError } from "src/common/utils/handler-error.utils";

@Injectable()
export class PdfKitTableService {

  private readonly logger = new Logger('PdfKitTableService');
  private readonly pathJson = 'company.json';

  constructor(
    private readonly jsonHandlerService: JsonHandlerService,
  ) { }

  // async generatePdf(pdfOptions: PdfOptions): Promise<any> {
  //   const PDFDocument = require("pdfkit-table");
  //   const { author, title, subtitle, headers, rows, titleTable } = pdfOptions;
  //   const company: CompanyEntity = await this.getCompany();
  //   let doc = new PDFDocument({ margin: 20 });

  //   doc.info.Title = title;
  //   doc.info.Author = author || "Mi Gasolinera";

  //   // header
  //   doc.rect(0, 0, doc.page.width, 80).fillAndStroke("#fff", "#fff");
  //   doc.fontSize(14).fillColor("#000").text(company.name, { align: 'left', });
  //   doc.fontSize(10).text(`Dir: ${company.direction}`, { align: 'left' });
  //   doc.fontSize(10).text(`Correo: ${company.email}`, { align: 'left' });
  //   doc.fontSize(10).text(`Tel: ${company.phone}`, { align: 'left' });
  //   doc.moveDown();

  //   if (company.logo_url !== '') {
  //     try {
  //       const logo = await this.fetchImage(company.logo_url);
  //       doc.image(logo, 540, 20, { fit: [50, 50], align: 'right', valign: 'right' });
  //       doc.moveDown();
  //       doc.moveDown();
  //     } catch (error) {
  //       console.error("Error fetching image:", error);
  //     }
  //   }
  //   doc.fillColor("#000000")
  //   doc.fontSize(20).font('Helvetica-Bold').text(title, titleStyle);
  //   doc.fontSize(10).font('Helvetica').text(subtitle, titleStyle);
  //   doc.moveDown();
  //   doc.moveDown();

  //   // table
  //   const table = {
  //     title: titleTable,
  //     headers,
  //     rows
  //   };
  //   // or columnsSize
  //   await doc.table(table, {
  //     prepareHeader: () => doc.font('Helvetica-Bold').fontSize(9),
  //     prepareRow: (row: any, i: number) => doc.font('Helvetica').fontSize(9),
  //     padding: 5,
  //     margin: { top: 30, bottom: 30 },
  //     columnSpacing: 8,
  //     width: doc.page.width - 40,
  //     addPageFn: () => doc.addPage(),
  //   });
  //   return doc;
  // }
  
  public async fetchImage(src: string): Promise<any> {
    const axios = require('axios');
    try {
      const response = await axios.get(src, {
        responseType: 'arraybuffer'
      });
      return response.data;
    } catch (error) {
      throw new Error(`Error fetching image from ${src}: ${error.message}`);
    }
  }

  // public async getOrganization(): Promise<OrganizationEntity> {
  //   try {
  //     const json = await this.jsonHandlerService.read(this.pathJson);
  //     return json;
  //   } catch (error) {
  //     handlerError(error, this.logger);
  //     throw error;
  //   }
  // }
}