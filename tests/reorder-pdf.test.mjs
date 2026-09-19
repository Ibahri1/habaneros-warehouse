import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfText } from "../supabase/functions/_shared/pdf-text.mjs";

test("PDF text normalizes narrow and regular no-break spaces while preserving accents",async()=>{
  const timestamp="September 18, 2026 at 2:00\u202FPM";
  const product="Jalapeño\u00A0Café Sauce";
  const document=await PDFDocument.create();
  const font=await document.embedFont(StandardFonts.Helvetica);
  const page=document.addPage([612,792]);
  const normalizedTimestamp=pdfText(timestamp);
  const normalizedProduct=pdfText(product);
  assert.equal(normalizedTimestamp,"September 18, 2026 at 2:00 PM");
  assert.equal(normalizedProduct,"Jalapeño Café Sauce");
  assert.doesNotThrow(()=>font.widthOfTextAtSize(normalizedTimestamp,10));
  assert.doesNotThrow(()=>font.widthOfTextAtSize(normalizedProduct,10));
  page.drawText(normalizedTimestamp,{x:40,y:740,size:10,font});
  page.drawText(normalizedProduct,{x:40,y:720,size:10,font});
  const bytes=await document.save();
  assert.ok(bytes.length>500,"a real PDF was generated");
  assert.equal(String.fromCharCode(...bytes.slice(0,5)),"%PDF-");
});
