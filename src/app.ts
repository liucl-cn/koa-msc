import Koa from 'koa'
import * as path from "path";
import {Server as HttpServer} from 'http'
import KoaBodyParser from "koa-bodyparser";
import * as fs from 'fs'
import {Class, deepClone, deepMerge} from "./utils";
import {Logger,getLogger} from "log4js";
import {models} from "./model";
import {services} from "./service";
import {controllers} from "./controller";
import {Model,Options as DataBaseConfig,Sequelize} from "sequelize";
import {Router} from "./router";
import {MethodConfig, RouteConfig} from "./decorators";

export class App extends Koa{
    public config:App.Config
    public logger:Logger
    public models:Record<string, Model>={}
    public services:Record<string, Class>={}
    public controllers:Record<string,Class>={}
    public router:Router
    public httpServer:HttpServer
    public sequelize:Sequelize
    constructor(config:App.Config) {
        super(config.koa)
        this.config=deepMerge(deepClone(App.defaultConfig) as App.Config,config)
        this.router=new Router(this.config.router)
        this.logger=this.getLogger('[app]')
        this.logger.info('正在初始化...')
        this.init()
        this.use(async (ctx,next)=>{
            const start=+new Date()
            await next()
            this.logger.info(`[${ctx.method}:${ctx.req.url}]:耗时${(+new Date())-start}ms`)
        })
    }
    init(){
        this.createDataBasePool()
        this.initModels()
        this.initServices()
        this.initControllers()
    }
    createDataBasePool(){
        this.logger.info('正在创建数据库连接...')
        this.sequelize=new Sequelize(this.config.sequelize)
    }
    initModels(){
        this.logger.info('正在扫描并创建Models')
        for(const [M] of this.load(this.config.model_path,"models")){
            const name=M.name.replace('Model','')
            // @ts-ignore
            this.models[name]=Model.init(M,{sequelize:this.sequelize,modelName:name})
        }
    }
    initServices(){
        this.logger.info('正在扫描并创建Services')
        for(const [S] of this.load(this.config.service_path,'services')){
            const name=S.name.replace('Service','')
            this.services[name]=new S(this.models[name],this.models)
        }
    }
    initControllers(){
        this.logger.info('正在扫描并创建Controllers')
        for(const [C] of this.load(this.config.controller_path,'controllers')){
            const name=C.name.replace('Controller','')
            this.controllers[name]=new C(this.services[name],this.services)
            const routeConfig:RouteConfig=C.prototype.__ROUTE__;
            const methodsConfig:MethodConfig[]=C.prototype.__METHODS__;
            for(const methodConfig of methodsConfig){
                for(const method of methodConfig.method){
                    const path=routeConfig.path.split('/').concat(methodConfig.path.split('/')).filter(Boolean)
                        .join('/')
                    this.router[method.toLowerCase()]('/'+path,async (ctx)=>{
                        const result=await this.controllers[name][methodConfig.name](ctx)
                        if(result) ctx.body=result
                    })
                }
            }
        }
    }
    load<T extends 'controllers'|'services'|'models'>(dir,type:T):Map<Class, Class>{
        const url = path.resolve(__dirname, dir);
        const files = fs.readdirSync(url);
        files.forEach(file => {
            if(file.endsWith('.js') || (file.endsWith('.ts') && !file.endsWith('.d.ts'))){
                const filename = file.replace('.js', '').replace('.ts','');
                require(url+'/'+filename);
            }
        });
        switch (type){
            case "services":
                return services
            case "models":
                return models
            case "controllers":
                return controllers
            default:
                throw '未知加载类型'
        }
    }

    getLogger(category:string){
        const logger:Logger=getLogger(category)
        logger.level=this.config.log_level
        return logger
    }
    async start(port:number){
        this.logger.info('正在同步数据库Models')
        await this.sequelize.sync({alter:true}).catch(e=>{
            this.logger.error(e)
        })
        this.use(KoaBodyParser())
            .use(this.router.routes())
            .use(this.router.allowedMethods())
        this.listen(port,()=>{
            this.logger.info(`server listen at http://0.0.0.0:${port}`)
        })
    }
}
export namespace App{
    interface KoaOptions{
        env?: string
        keys?: string[]
        proxy?: boolean
        subdomainOffset?: number
        proxyIpHeader?: string
        maxIpsCount?: number
    }
    export const defaultConfig:Partial<Config>={
        controller_path:'controllers',
        model_path:'models',
        log_level:'info',
        service_path:'services',
    }
    export type LogLevel="trace" | "debug" | "info" | "warn" | "error" | "fatal" | "mark" | "off"
    export interface Config{
        log_level?:LogLevel
        controller_path?:string
        service_path?:string
        model_path?:string
        koa?:KoaOptions
        router?:Router.Options
        sequelize:DataBaseConfig
    }
}
