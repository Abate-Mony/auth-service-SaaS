export const checkForProduction=():boolean=>{

    if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
        // dev code
        return false
    } else {
        // production code
        return true
    }


}