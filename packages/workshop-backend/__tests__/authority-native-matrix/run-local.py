"""Bounded diagnostic driver; no installs, provider access or implicit retries."""
import os, pathlib, subprocess, time, json, socket, http.client, signal, sys, shutil
if len(sys.argv) < 3:
    sys.exit('Usage: run-local.py EVIDENCE_DIRECTORY pool LABEL CONFIG [FILTER] | standalone')
E=pathlib.Path(sys.argv.pop(1)).resolve(); E.mkdir(parents=True, exist_ok=True)
ROOT=pathlib.Path(__file__).resolve().parents[4]
NODE=shutil.which('node')
if NODE is None: sys.exit('Existing node executable is required')
HOME=E/'home'; HOME.mkdir(exist_ok=True)
TMP=E/'tmp'; TMP.mkdir(exist_ok=True)
env={'PATH':str(pathlib.Path(NODE).parent)+':/usr/bin:/bin','HOME':str(HOME),'TMPDIR':str(TMP), 'XDG_CONFIG_HOME':str(HOME),'XDG_CACHE_HOME':str(HOME),'WRANGLER_SEND_METRICS':'false','CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV':'false','CI':'true'}
profile=E/'pool.sb'
profile.write_text('''(version 1)
(allow default)
(deny network*)
(allow network* (local ip "localhost:*") (remote ip "localhost:*"))
(deny file-read* (regex #"/(\\.env[^/]*|\\.dev\\.vars[^/]*|\\.npmrc)$"))
(deny file-read* file-write* (subpath "/Users/jacob_1/.config") (subpath "/Users/jacob_1/.wrangler"))
''')

def record(name, command, code, **extra):
    with (E/'commands.jsonl').open('a') as f: f.write(json.dumps({'name':name,'command':command,'exit':code,**extra})+'\n')

def stop(p):
    if p.poll() is None:
        os.killpg(p.pid,signal.SIGTERM)
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL); p.wait()

if sys.argv[1]=='pool':
    label, config, *files=sys.argv[2:]
    cmd=['/usr/bin/sandbox-exec','-f',str(profile),NODE,str(ROOT/'packages/workshop-backend/node_modules/vitest/vitest.mjs'),'run','--config',config,*files,'--reporter=default','--reporter=json','--outputFile='+str(E/(label+'.json'))]
    if (E/(label+'.log')).exists(): sys.exit('Refusing to overwrite a previous run')
    with (E/(label+'.log')).open('w') as log:
        p=subprocess.Popen(cmd,cwd=ROOT/'packages/workshop-backend',env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try: code=p.wait(timeout=60)
        except subprocess.TimeoutExpired:
            stop(p); record(label,cmd,None,infrastructureFailure='60s process bound'); sys.exit(70)
    record(label,cmd,code)
    text=(E/(label+'.log')).read_text()
    if not (E/(label+'.json')).exists() or 'Failed to start' in text or 'ERR_MODULE_NOT_FOUND' in text:
        print(text[-4000:]); sys.exit(70)
    print(text[-4500:])
    sys.exit(code)

if sys.argv[1]=='standalone':
    fixture=pathlib.Path((E/'standalone-path.txt').read_text().strip())
    listener=socket.socket(); listener.bind(('127.0.0.1',0)); listener.listen(20)
    port=listener.getsockname()[1]
    cmd=['/usr/bin/sandbox-exec','-f',str(fixture/'sandbox.sb'),str(fixture/'workerd'),'serve',str(fixture/'config.capnp'),'config','--socket-fd','http='+str(listener.fileno())]
    if (E/'standalone.log').exists(): sys.exit('Refusing to overwrite a previous run')
    log=(E/'standalone.log').open('w')
    p=subprocess.Popen(cmd,cwd=fixture,env=env,stdout=log,stderr=subprocess.STDOUT,pass_fds=(listener.fileno(),),start_new_session=True)
    listener.close()
    def request(path,timeout):
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=timeout)
        try:
            c.request('GET','/'+path); r=c.getresponse(); return r.status,r.read().decode()
        finally: c.close()
    try:
        start=time.monotonic(); ready=False
        while time.monotonic()-start<60 and p.poll() is None:
            try:
                status,body=request('ready',6)
                (E/'standalone-preflight.json').write_text(body)
                if status==200 and json.loads(body).get('ready') is True: ready=True; break
                record('standalone-preflight',cmd,status,infrastructureFailure=body)
                sys.exit(70)
            except (TimeoutError,http.client.HTTPException) as error:
                record('standalone-preflight',cmd,None,infrastructureFailure=str(error)); sys.exit(70)
            except ConnectionRefusedError: pass
            time.sleep(.05)
        if not ready:
            record('standalone',cmd,p.poll(),infrastructureFailure='startup failed'); sys.exit(70)
        failures=0
        for case in ['pipeTo','explicit-pump','cancel','graceful']:
            try: status,body=request(case,15)
            except (OSError,http.client.HTTPException) as error:
                record(case,cmd,None,infrastructureFailure=str(error)); sys.exit(70)
            (E/('standalone-'+case+'.json')).write_text(body)
            try: result=json.loads(body)
            except json.JSONDecodeError:
                record(case,cmd,status,caseFailure='non-JSON worker exception'); print(body); sys.exit(1)
            record('standalone-'+case,cmd,0 if status==200 else 1,httpStatus=status,result=result)
            print(json.dumps(result))
            if status>=400: failures+=1
            if result.get('cleanupFailure') is not None or result.get('assertionFailure') is not None:
                record(case,cmd,status,infrastructureFailure='scenario setup/assertion/cleanup failed; stopped immediately')
                sys.exit(70)
    finally:
        stop(p); log.close(); record('standalone-process-cleanup',cmd,p.returncode)
    sys.exit(1 if failures else 0)
