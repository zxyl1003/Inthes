import { abortable } from './abort.ts';
import { paperIdentifier } from './research.ts';
import type { ImportResult, PaperIdentifier, ResearchCollection, ResearchPaper } from './research.ts';

export function importCollections(): ResearchCollection[] {
  const result:ResearchCollection[]=[];
  for(const library of Zotero.Libraries.getAll()) {
    if(!library.editable||!['user','group'].includes(library.libraryType))continue;
    for(const c of Zotero.Collections.getByLibrary(library.libraryID,true)) {
      if(c.deleted)continue;
      const names=[c.name];let parent=c.parentID;
      while(parent){const p=Zotero.Collections.get(parent);names.unshift(p.name);parent=p.parentID;}
      result.push({id:c.id,libraryID:library.libraryID,name:c.name,path:`${library.name} / ${names.join(' / ')}`});
    }
  }
  return result;
}
function arxivID(value:string) {
  const match=value.match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)/i);
  return match?paperIdentifier(match[1]).arXiv:undefined;
}
export function resolvedPaper(id:PaperIdentifier,data:any):ResearchPaper {
  if(!data||typeof data!=='object'||typeof data.title!=='string'||!data.title.trim()||!['journalArticle','conferencePaper','preprint','report','thesis','bookSection'].includes(data.itemType))throw new Error('标识符解析器未返回有效的论文书目信息');
  const doi=typeof data.DOI==='string'&&data.DOI.trim()?paperIdentifier(data.DOI).DOI:undefined;
  const arxiv=arxivID([data.url,data.extra, data.DOI, data.archiveLocation?`arXiv: ${data.archiveLocation}`:''].filter(v=>typeof v==='string').join('\n'));
  if(id.DOI&&doi!==id.DOI||id.arXiv&&arxiv!==id.arXiv)throw new Error('返回的论文标识与请求不符，未通过核验');
  const metadata:Record<string,any>={itemType:data.itemType,title:data.title.trim()};
  for(const field of ['date','DOI','publicationTitle','proceedingsTitle','conferenceName','volume','issue','pages','publisher','place','abstractNote','ISSN','ISBN','language','seriesTitle','archive','archiveLocation','libraryCatalog','shortTitle'])if(typeof data[field]==='string'&&data[field].length<=100000)metadata[field]=data[field];
  const url=doi?`https://doi.org/${doi}`:`https://arxiv.org/abs/${arxiv}`;
  metadata.url=url;if(arxiv)metadata.extra=`arXiv: ${arxiv}`;
  metadata.creators=(Array.isArray(data.creators)?data.creators:[]).filter((c:any)=>c&&typeof c.lastName==='string'&&(!c.creatorType||c.creatorType==='author')).map((c:any)=>({creatorType:'author',...(c.fieldMode===1?{name:c.lastName}:{firstName:typeof c.firstName==='string'?c.firstName:'',lastName:c.lastName})}));
  return {identifier:id.key,title:metadata.title,date:metadata.date||'',authors:metadata.creators.map((c:any)=>c.name||`${c.firstName} ${c.lastName}`.trim()),url,doi,arxiv,metadata};
}
export async function resolveResearchPaper(win:any,id:PaperIdentifier,signal:AbortSignal):Promise<ResearchPaper> {
  let timer:any;
  const lookup=async()=>{
    const translate=new Zotero.Translate.Search();translate.setIdentifier(id.DOI?{DOI:id.DOI}:{arXiv:id.arXiv});
    const translators=await translate.getTranslators();signal.throwIfAborted();
    if(!translators.length)throw new Error('Zotero 没有可用的标识符解析器');
    translate.setTranslator(translators);
    // Lookup must never save; imports only happen after identity and duplicate checks.
    const items=await translate.translate({libraryID:false,saveAttachments:false});signal.throwIfAborted();
    if(items.length!==1)throw new Error('标识符未能解析为唯一论文');
    return resolvedPaper(id,items[0]);
  };
  try{return await abortable(Promise.race([lookup(),new Promise<never>((_,reject)=>{timer=win.setTimeout(()=>reject(new Error('论文元数据核验超时，请稍后重试')),45000);})]),signal);}
  finally{win.clearTimeout(timer);}
}
export interface ExistingPaper { id:number; title:string; doi?:string; arxiv?:string; year:string; author:string; }
const normalized=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function duplicatePaper(paper:ResearchPaper,items:ExistingPaper[]) {
  const exact=items.filter(i=>paper.doi&&paper.doi===i.doi||paper.arxiv&&paper.arxiv===i.arxiv);
  if(exact.length)return {kind:exact.length===1?'exact' as const:'possible' as const,items:exact};
  const title=normalized(paper.title),year=paper.date.match(/\d{4}/)?.[0]||'',authors=paper.authors.map(normalized);
  const similar=items.filter(i=>normalized(i.title)===title);
  if(!similar.length)return {kind:'new' as const,items:[]};
  // Matching titles with different identifiers can be preprint/publication versions.
  const reliable=similar.filter(i=>!(paper.doi&&i.doi&&paper.doi!==i.doi)&&!(paper.arxiv&&i.arxiv&&paper.arxiv!==i.arxiv)&&year&&year===i.year&&i.author&&authors.some(a=>a===normalized(i.author)));
  return reliable.length===1&&similar.length===1?{kind:'exact' as const,items:reliable}:{kind:'possible' as const,items:similar};
}
function existingPaper(item:any):ExistingPaper {
  const rawDOI=String(item.getField('DOI')||'').trim();let doi:string|undefined;
  if(rawDOI){try{doi=paperIdentifier(rawDOI).DOI;}catch{/* Invalid existing DOI is compared by title instead. */}}
  const creators=item.getCreators(),author=creators.find((c:any)=>Zotero.CreatorTypes.getName(c.creatorTypeID)==='author');
  return {id:item.id,title:item.getField('title')||'',doi,arxiv:arxivID([item.getField('url'),item.getField('extra'),rawDOI,item.getField('archiveLocation')?`arXiv: ${item.getField('archiveLocation')}`:''].join('\n')),year:String(item.getField('date')||'').match(/\d{4}/)?.[0]||'',author:author?`${author.firstName||''} ${author.lastName||''}`.trim():''};
}
let importQueue:Promise<void>=Promise.resolve();
export function importResearchPapers(papers:ResearchPaper[],target:ResearchCollection,signal:AbortSignal,completed:(result:ImportResult)=>void):Promise<void> {
  const work=importQueue.then(async()=>{
    signal.throwIfAborted();
    const collection=Zotero.Collections.get(target.id),library=Zotero.Libraries.get(target.libraryID);
    if(!collection||collection.deleted||collection.libraryID!==target.libraryID||!library?.editable)throw new Error('目标分类不存在或文库不可写');
    const items=(await Zotero.Items.getAll(target.libraryID,true,false)).filter((i:any)=>i.isRegularItem());
    await Promise.all(items.map((i:any)=>i.loadAllData()));signal.throwIfAborted();
    const known:ExistingPaper[]=items.map(existingPaper);
    for(const paper of papers) {
      signal.throwIfAborted();
      let result:ImportResult;
      try {
        const duplicate=duplicatePaper(paper,known);
        if(duplicate.kind==='possible')result={identifier:paper.identifier,title:paper.title,status:'possible_duplicate',detail:duplicate.items.map(i=>i.title).join('；')};
        else {
          result=await Zotero.DB.executeTransaction(async()=>{
            signal.throwIfAborted();
            if(collection.deleted||!library.editable)throw new Error('目标分类已删除或文库变为只读');
            let item;
            if(duplicate.kind==='exact') {
              item=Zotero.Items.get(duplicate.items[0].id);
              if(item.deleted)throw new Error('匹配的已有条目已删除，请重试');
              if(item.inCollection(target.id))return {identifier:paper.identifier,title:paper.title,status:'exists',itemID:item.id} as ImportResult;
            } else {
              item=new Zotero.Item(paper.metadata.itemType);item.libraryID=target.libraryID;item.fromJSON(paper.metadata);
            }
            item.addToCollection(target.id);await item.save();
            return {identifier:paper.identifier,title:paper.title,status:duplicate.kind==='exact'?'added':'created',itemID:item.id} as ImportResult;
          });
          if(result.status==='created')known.push(existingPaper(Zotero.Items.get(result.itemID)));
        }
      }catch(error){signal.throwIfAborted();result={identifier:paper.identifier,title:paper.title,status:'failed',detail:String((error as Error).message||error)};}
      completed(result);
    }
  });
  importQueue=work.then(()=>{},()=>{}); // Two panels cannot create the same new paper concurrently.
  return work;
}
