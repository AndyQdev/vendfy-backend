export interface ExcelOptions {
  creator?: string;
  lastModifiedBy?: string;
  title: string;
  header: string[];
  rows: any[];
}

export interface ExcelRow {
  row: any[];
}