// Combine realtime bursts and catch-up queries without ingesting the same row twice.
export function createMessageBatcher(process, {size=50, delay=30}={}) {
    const jobs=new Map(), handled=new Set(), queue=[];
    let running=false, timer=null;
    const drain=async()=>{
        if(running)return;running=true;timer=null;
        try {
            while(queue.length){
                const batch=queue.splice(0,size);
                try {
                    const completed=await process(batch.map(job=>job.row));
                    for(const job of batch){
                        const done=completed.has(job.row.id);
                        if(done){handled.add(job.row.id);if(handled.size>1000)handled.delete(handled.values().next().value);}
                        jobs.delete(job.row.id);job.resolve(done);
                    }
                }catch(error){for(const job of batch){jobs.delete(job.row.id);job.reject(error);}}
            }
        }finally{running=false;}
    };
    return rows=>Promise.all(rows.map(row=>{
        if(!row?.id||handled.has(row.id))return Promise.resolve(false);
        if(jobs.has(row.id))return jobs.get(row.id).promise;
        let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
        const job={row,promise,resolve,reject};jobs.set(row.id,job);queue.push(job);
        if(!running&&!timer)timer=setTimeout(drain,delay);
        return promise;
    }));
}
