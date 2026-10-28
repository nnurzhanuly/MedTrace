import './globals.css';
import './reference-redesign.css';
import type {Metadata} from 'next';
export const metadata:Metadata={title:'MedTrace · Демо интерфейса',description:'Интерактивная демонстрация прослеживаемости партий медицинских изделий без сервера и входа'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru"><body>{children}</body></html>}
