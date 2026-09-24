import { zipSync, strToU8 } from 'fflate';

const xml = (value:string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]!);
// KaTeX's presentation MathML becomes editable Office equations rather than screenshots.
function officeMath(node:Element):string {
  const children=Array.from(node.children), child=(i:number)=>children[i]?officeMath(children[i]):'', all=()=>children.map(officeMath).join('');
  switch(node.localName) {
    case 'annotation': return '';
    case 'semantics': return child(0);
    case 'mi': case 'mn': case 'mo': case 'mtext': case 'ms': return `<m:r>${node.localName==='mtext'?'<m:rPr><m:sty m:val="p"/></m:rPr>':''}<m:t xml:space="preserve">${xml(node.textContent||'')}</m:t></m:r>`;
    case 'mspace': return '<m:r><m:t xml:space="preserve"> </m:t></m:r>';
    case 'mfrac': return `<m:f><m:num>${child(0)}</m:num><m:den>${child(1)}</m:den></m:f>`;
    case 'msqrt': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${all()}</m:e></m:rad>`;
    case 'mroot': return `<m:rad><m:deg>${child(1)}</m:deg><m:e>${child(0)}</m:e></m:rad>`;
    case 'msub': return `<m:sSub><m:e>${child(0)}</m:e><m:sub>${child(1)}</m:sub></m:sSub>`;
    case 'msup': return `<m:sSup><m:e>${child(0)}</m:e><m:sup>${child(1)}</m:sup></m:sSup>`;
    case 'msubsup': return `<m:sSubSup><m:e>${child(0)}</m:e><m:sub>${child(1)}</m:sub><m:sup>${child(2)}</m:sup></m:sSubSup>`;
    case 'munder': return `<m:limLow><m:e>${child(0)}</m:e><m:lim>${child(1)}</m:lim></m:limLow>`;
    case 'mover': return `<m:limUpp><m:e>${child(0)}</m:e><m:lim>${child(1)}</m:lim></m:limUpp>`;
    case 'munderover': return `<m:limUpp><m:e><m:limLow><m:e>${child(0)}</m:e><m:lim>${child(1)}</m:lim></m:limLow></m:e><m:lim>${child(2)}</m:lim></m:limUpp>`;
    case 'mtable': return `<m:m>${children.map(row=>`<m:mr>${Array.from(row.children).map(cell=>`<m:e>${officeMath(cell)}</m:e>`).join('')}</m:mr>`).join('')}</m:m>`;
    case 'mfenced': return `<m:d><m:dPr><m:begChr m:val="${xml(node.getAttribute('open')||'(')}"/><m:endChr m:val="${xml(node.getAttribute('close')||')')}"/></m:dPr><m:e>${all()}</m:e></m:d>`;
    default: return all();
  }
}
export async function wordDocument(win:any, doc:Document):Promise<Uint8Array> {
  const files:Record<string,Uint8Array>={}, relationships:string[]=[], pictures=new Map<Element,{id:string;cx:number;cy:number;number:number}>();
  const relationship=(type:string,target:string,external=false)=>{const id='rId'+(relationships.length+1);relationships.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xml(target)}"${external?' TargetMode="External"':''}/>`);return id;};
  for (const img of doc.querySelectorAll('img')) {
    const loaded=new win.Image();loaded.src=img.src;await loaded.decode();
    let url=img.src;
    if (url.startsWith('data:image/webp;')) {const canvas=win.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=loaded.naturalWidth;canvas.height=loaded.naturalHeight;canvas.getContext('2d').drawImage(loaded,0,0);url=canvas.toDataURL('image/png');}
    const number=pictures.size+1, extension=url.startsWith('data:image/jpeg;')?'jpg':'png', name=`media/image${number}.${extension}`;
    files['word/'+name]=Uint8Array.from(atob(url.slice(url.indexOf(',')+1)),c=>c.charCodeAt(0));
    const scale=Math.min(1,600/loaded.naturalWidth,850/loaded.naturalHeight);
    pictures.set(img,{id:relationship('image',name),number,cx:Math.round(loaded.naturalWidth*scale*9525),cy:Math.round(loaded.naturalHeight*scale*9525)});
  }
  function run(text:string,properties='') {return text.split('\n').map((line,i)=>`${i?'<w:r><w:br/></w:r>':''}<w:r>${properties?`<w:rPr>${properties}</w:rPr>`:''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('');}
  function inline(node:Node,properties=''):string {
    if(node.nodeType===3)return run((node.textContent||'').replace(/\s*\n\s*/g,' '),properties);
    if(node.nodeType!==1)return '';
    const el=node as Element,tag=el.localName;
    if(tag==='math')return `<m:oMath>${officeMath(el)}</m:oMath>`;
    if(tag==='br')return '<w:r><w:br/></w:r>';
    if(tag==='img'){
      const p=pictures.get(el)!;
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${p.cx}" cy="${p.cy}"/><wp:docPr id="${p.number}" name="Image ${p.number}" descr="${xml(el.getAttribute('alt')||'')}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${p.number}" name="Image ${p.number}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${p.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${p.cx}" cy="${p.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }
    let props=properties;
    if(tag==='strong'&&!props.includes('<w:b/>'))props+='<w:b/>';
    if(tag==='em'&&!props.includes('<w:i/>'))props+='<w:i/>';
    if(tag==='del'&&!props.includes('<w:strike/>'))props+='<w:strike/>';
    if(tag==='code'&&!props.includes('<w:rFonts '))props+='<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>';
    const href=el.getAttribute('href');
    if(tag==='a'&&href)props+='<w:rStyle w:val="Hyperlink"/>';
    const content=Array.from(el.childNodes).map(n=>inline(n,props)).join('');
    return tag==='a'&&href?`<w:hyperlink r:id="${relationship('hyperlink',href,true)}">${content}</w:hyperlink>`:content;
  }
  const paragraph=(content:string,properties='')=>`<w:p>${properties?`<w:pPr>${properties}</w:pPr>`:''}${content}</w:p>`;
  let documentNumber=0;
  function blocks(parent:Element,depth=0,kind=''):string {
    let output='',pending='';
    const baseStyle=kind==='meta'||kind==='answer-label'?'Metadata':kind==='papers'?'Bibliography':kind==='source'?'Source':kind==='question'?'Question':'Normal';
    const styled=(style:string)=>`<w:pStyle w:val="${style}"/>`;
    const flush=()=>{if(pending){output+=paragraph(pending,styled(baseStyle));pending='';}};
    for(const node of Array.from(parent.childNodes)) {
      if(node.nodeType!==1){if(node.textContent?.trim())pending+=inline(node);continue;}
      const el=node as Element,tag=el.localName;
      if(tag==='section'){flush();output+=blocks(el,depth,(el as HTMLElement).dataset.folioKind||'');continue;}
      if(el.classList.contains('display-formula')){flush();output+=paragraph(inline(el),'<w:jc w:val="center"/><w:spacing w:before="100" w:after="100"/><w:keepLines/>');continue;}
      if(!/^(p|h[1-6]|ul|ol|pre|blockquote|table|hr)$/.test(tag)){pending+=inline(el);continue;}
      flush();
      if(tag==='ul'||tag==='ol') {
        for(const [i,li] of Array.from(el.children).entries()) {
          const prefix=tag==='ol'?`${i+(Number(el.getAttribute('start'))||1)}. `:'• ',indent=styled(kind==='papers'?'Bibliography':'List')+`<w:ind w:left="${360*(depth+1)}" w:hanging="240"/>`;
          let first=true,content='';
          const emit=()=>{if(content){output+=paragraph((first?run(prefix):'')+content,indent);content='';first=false;}};
          for(const part of Array.from(li.childNodes)) {
            const name=(part as Element).localName;
            if(name==='ul'||name==='ol') {emit();const holder=doc.createElement('div');holder.append(part.cloneNode(true));output+=blocks(holder,depth+1,kind);}
            else if(name==='p') {emit();content=inline(part);emit();}
            else if(part.nodeType===1||part.textContent?.trim())content+=inline(part);
          }
          emit();
        }
      } else if(tag==='table') {
        const table=el as HTMLTableElement,rows=Array.from(table.rows);
        type Cell={element:HTMLTableCellElement;span:number;merge:boolean;continued:boolean};
        const grid=rows.map((): (Cell|null|undefined)[]=>[]);
        for(const [r,row] of rows.entries()) {
          let column=0;
          for(const cell of Array.from(row.cells)) {
            while(grid[r][column]!==undefined)column++;
            const remaining=(row.parentElement as HTMLTableSectionElement).rows.length-row.sectionRowIndex;
            const end=r+Math.min(cell.rowSpan||remaining,remaining);
            for(let y=r;y<end;y++) {
              grid[y][column]={element:cell,span:cell.colSpan,merge:end>r+1,continued:y>r};
              for(let x=1;x<cell.colSpan;x++)grid[y][column+x]=null;
            }
            column+=cell.colSpan;
          }
        }
        const columns=Math.max(1,...grid.map(row=>row.length)),width=Math.floor(9300/columns);
        if(table.caption)output+=paragraph(inline(table.caption),styled('TableText'));
        output+=`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(side=>`<w:${side} w:val="single" w:sz="4" w:color="DCE2DC"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({length:columns},()=>`<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${grid.map((row,r)=>`<w:tr><w:trPr><w:cantSplit/>${rows[r].querySelector('th')?'<w:tblHeader/>':''}</w:trPr>${Array.from({length:columns},(_,c)=>{
          const cell=row[c];if(cell===null)return '';
          const header=cell?.element.localName==='th';
          return `<w:tc><w:tcPr><w:tcW w:w="${width*(cell?.span||1)}" w:type="dxa"/>${cell&&cell.span>1?`<w:gridSpan w:val="${cell.span}"/>`:''}${cell?.merge?`<w:vMerge w:val="${cell.continued?'continue':'restart'}"/>`:''}${header?'<w:shd w:fill="F1F4F1"/>':''}</w:tcPr>${paragraph(cell&&!cell.continued?inline(cell.element,header?'<w:b/>':''):'',styled('TableText'))}</w:tc>`;
        }).join('')}</w:tr>`).join('')}</w:tbl>`;
      } else if(tag==='blockquote') output+=blocks(el,depth,'source');
      else if(tag==='hr') output+=paragraph('', '<w:spacing w:before="80" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:color="DCE2DC"/></w:pBdr>');
      else {
        const heading=/^h[1-6]$/.test(tag),style=kind==='title'?'Title':kind==='question'&&heading?'QuestionLabel':kind==='sources-label'?'References':heading?'Heading'+Math.max(1,Number(tag.slice(1))-1):tag==='pre'?'Code':baseStyle;
        const extra=(kind==='title'&&++documentNumber>1?'<w:pageBreakBefore/>':'')+(kind==='answer-label'?'<w:keepNext/>':'')+(el.querySelector('img')?'<w:keepLines/><w:jc w:val="center"/>':'');
        output+=paragraph(tag==='pre'?run(el.textContent||'','<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>'):inline(el),styled(style)+extra);
      }
    }
    flush();return output;
  }
  const content=blocks(doc.body);
  relationship('styles','styles.xml');
  const declaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  files['[Content_Types].xml']=strToU8(declaration+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  files['_rels/.rels']=strToU8(declaration+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  files['word/_rels/document.xml.rels']=strToU8(declaration+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`);
  const style=(id:string,size:number,color:string,properties='',bold=false)=>`<w:style w:type="paragraph"${id==='Normal'?' w:default="1"':''} w:styleId="${id}"><w:name w:val="${id}"/>${id==='Normal'?'':'<w:basedOn w:val="Normal"/>'}<w:pPr>${properties}</w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/><w:color w:val="${color}"/><w:sz w:val="${size}"/>${bold?'<w:b/>':''}</w:rPr></w:style>`;
  files['word/styles.xml']=strToU8(declaration+`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>`+
    style('Normal',21,'252B28','<w:spacing w:after="120" w:line="315" w:lineRule="atLeast"/><w:widowControl/><w:snapToGrid w:val="0"/>')+
    style('Title',36,'252B28','<w:keepNext/><w:spacing w:before="0" w:after="100" w:line="280" w:lineRule="auto"/>',true)+
    style('Metadata',18,'738078','<w:spacing w:after="100" w:line="280" w:lineRule="auto"/>')+
    style('Bibliography',19,'59655E','<w:spacing w:after="60" w:line="270" w:lineRule="atLeast"/>')+
    style('QuestionLabel',18,'596E60','<w:keepNext/><w:spacing w:before="220" w:after="60"/><w:shd w:fill="F2F5F2"/><w:ind w:left="140" w:right="140"/>',true)+
    style('Question',21,'252B28','<w:spacing w:after="140"/><w:shd w:fill="F2F5F2"/><w:ind w:left="140" w:right="140"/>')+
    [1,2,3,4,5].map(level=>style('Heading'+level,level<=2?24:level===3?22:21,'252B28',`<w:keepNext/><w:spacing w:before="${level<=2?200:160}" w:after="80" w:line="280" w:lineRule="auto"/><w:outlineLvl w:val="${level-1}"/>`,true)).join('')+
    style('List',21,'252B28','<w:spacing w:after="60" w:line="290" w:lineRule="atLeast"/>')+
    style('Source',18,'657067','<w:spacing w:after="80" w:line="270" w:lineRule="atLeast"/><w:ind w:left="180"/>')+
    style('References',22,'455249','<w:keepNext/><w:spacing w:before="240" w:after="100"/>',true)+
    style('TableText',19,'252B28','<w:spacing w:after="40" w:line="270" w:lineRule="atLeast"/>')+
    style('Code',18,'252B28','<w:spacing w:before="80" w:after="120" w:line="250" w:lineRule="atLeast"/><w:shd w:fill="F4F5F3"/>')+
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="496E59"/></w:rPr></w:style></w:styles>');
  files['word/document.xml']=strToU8(declaration+`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1021" w:right="1134" w:bottom="1021" w:left="1134"/></w:sectPr></w:body></w:document>`);
  return zipSync(files);
}
