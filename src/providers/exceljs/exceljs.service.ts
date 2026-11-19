import { Injectable, Logger } from "@nestjs/common";
import { ExcelOptions } from "./excel-optons.interface";
import { getDate } from "src/common/utils/get-date.utils";
import { alphabetArray } from "./cell.constants";
import { alignmentStyle, fillStyle, fillTableStyle, fontStyle } from "./styles";
import { handlerError } from "src/common/utils/handler-error.utils";

@Injectable()
export class ExcelJsService {

    constructor() { }

    private readonly logger = new Logger('ExcelJsService');

    async generateExcel(excelOptions: ExcelOptions): Promise<Buffer> {
        try {
            const { creator, lastModifiedBy, title, rows, header } = excelOptions;
            const { date } = getDate();
            const exceljs = require('exceljs');
            const workbook = new exceljs.Workbook();
            workbook.creator = creator || 'Mi gasolinera';
            workbook.lastModifiedBy = lastModifiedBy || 'Mi gasolinera';
            workbook.views = [{
                x: 0, y: 0, width: 10000, height: 20000,
                firstSheet: 0, activeTab: 1, visibility: 'visible'
            }]
            const worksheet = workbook.addWorksheet(title);

            // Header
            const arrayCells = alphabetArray;
            const lengthHeader = header.length;
            const lastCell = arrayCells[lengthHeader];

            worksheet.mergeCells(`A1:${lastCell}1`);
            const gasolineraCell = worksheet.getCell('A1');
            gasolineraCell.value = creator || 'MI GASOLINERA';
            gasolineraCell.fill = fillStyle;
            gasolineraCell.font = fontStyle;
            gasolineraCell.alignment = alignmentStyle;

            worksheet.mergeCells(`A2:${lastCell}2`);
            const fechaCell = worksheet.getCell('A2');
            fechaCell.value = title;
            fechaCell.fill = fillStyle;
            fechaCell.font = fontStyle;
            fechaCell.alignment = alignmentStyle;

            const spaceCell = worksheet.getCell('A4');
            spaceCell.value = '';

            // Table
            header.forEach((header: string, i: number) => {
                const rowHeader = worksheet.getRow(5);
                rowHeader.getCell(i + 1).value = header;
                rowHeader.getCell(i + 1).fill = fillTableStyle;
                worksheet.getColumn(i + 1).width = 25;

            });

            let index = 6;
            rows.forEach((data: any, i: number) => {
                const rowData = worksheet.getRow(index);
                data.forEach((value: any, j: number) => {
                    rowData.getCell(j + 1).value = value || '';
                });
                index++;
            });
            const buffer = await workbook.xlsx.writeBuffer();
            return buffer;
        } catch (error) {
            handlerError(error, this.logger);
            throw new Error('Failed to fetch branches');
        }

    }
}