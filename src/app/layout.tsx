import './globals.css';
import './design-refresh.css';
import type {Metadata} from 'next';
export const metadata:Metadata={title:'MedTrace · Прослеживаемость партий',description:'Внутренняя платформа прослеживаемости медицинских изделий'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru"><body>{children}</body></html>}
